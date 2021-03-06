import Uri from 'vscode-uri';
import { VersionRequirement } from '../runner/version';
import { Ast, AstItem, AstList, AstToken, AstVal, AstValueType, findValue, getStringValue, getText, getValueType, NodeType, VisitedNode, walk } from './ast';
import { Diagnostic, DiagnosticSeverity } from './diagnostic';
import { FileIndex, TerraformSection } from './file-index';
import { ParseError, parseHilWithPosition } from './hcl-hil';
import { Location } from './location';
import { Position } from './position';
import { Property } from './property';
import { Range } from './range';
import { Reference } from './reference';
import { Section } from './section';

function createPosition(pos: any, columnDelta: number = 0, lineDelta: number = 0): Position {
    return new Position(pos.Line - 1 + lineDelta, pos.Column - 1 + columnDelta);
}

function createRange(start: any, end: any): Range {
    return new Range(createPosition(start), createPosition(end, 1));
}

function locationFromToken(uri: Uri, token: AstToken, strip: boolean): Location {
    const text = getText(token, { stripQuotes: strip });

    const start = createPosition(token.Pos, strip ? 1 : 0);
    const end = start.translate({ characterDelta: text.length });

    return new Location(uri, new Range(start, end));
}

function extractProperties(uri: Uri, list: AstList): Property[] {
    if (!list || !list.Items)
        return [];

    return list.Items.map((item) => {
        const nameToken = item.Keys[0].Token;

        const name = getText(nameToken);
        const nameLocation = locationFromToken(uri, nameToken, false);
        const valueLocation = new Location(uri, rangeFromVal(item.Val));

        let value: string | Property[];
        if (getValueType(item.Val) === AstValueType.Map) {
            value = extractProperties(uri, item.Val.List as AstList);
        } else {
            value = getStringValue(item.Val, "", { stripQuotes: true });
        }
        let property = new Property(name, nameLocation, value, valueLocation, item);

        return property;
    });
}

function sectionFromKeyItemNode(uri: Uri, item: any): Section {
    const isTypedSection = item.Keys.length === 3;

    const sectionType = item.Keys[0].Token.Text;

    let type: string = null;
    let typeLoc: Location = null;

    // typed section has name at index 2, untyped at 1
    let nameIndex = 1;

    if (isTypedSection) {
        nameIndex = 2;

        type = getText(item.Keys[1].Token, { stripQuotes: true });
        const typeStart = createPosition(item.Keys[1].Token.Pos, 1);
        const typeEnd = typeStart.translate({ characterDelta: type.length });
        typeLoc = new Location(uri, new Range(typeStart, typeEnd));
    }

    const name = getText(item.Keys[nameIndex].Token, { stripQuotes: true });
    const nameStart = createPosition(item.Keys[nameIndex].Token.Pos, 1);
    const nameStop = nameStart.translate({ characterDelta: name.length });
    const nameLoc = new Location(uri, new Range(nameStart, nameStop));

    const location = new Location(uri, createRange(item.Keys[0].Token.Pos, item.Val.Rbrace));

    return new Section(sectionType, type, typeLoc, name, nameLoc, location, item, extractProperties(uri, item.Val.List as AstList));
}

function startPosFromVal(val: AstVal): Position {
    if (val.Lbrace || val.Lbrack)
        return createPosition(val.Lbrace || val.Lbrack);

    return createPosition(val.Token.Pos);
}

function endPosFromVal(val: AstVal): Position {
    if (val.Rbrace || val.Rbrack)
        return createPosition(val.Rbrace || val.Rbrack, 1); // for maps/lists

    if (val.Token.Type === 10) {
        // HEREDOC
        // count lines
        const lines = val.Token.Text.split('\n');
        return new Position(val.Token.Pos.Line - 1 + lines.length - 2, lines[lines.length - 2].length);
        // we subtract 2 from lines.length before adding to start pos to compute
        // end pos because the HEREDOC Token looks like this: <<EOF\nstring\nEOF\n
    }

    return createPosition(val.Token.Pos, val.Token.Text.length); // for strings
}

function rangeFromVal(val: AstVal): Range {
    const start = startPosFromVal(val);
    const end = endPosFromVal(val);

    return new Range(start, end);
}

function sectionFromSingleKeyItemNode(uri: Uri, item: any): Section {
    const name = item.Keys[0].Token.Text;
    const nameStart = createPosition(item.Keys[0].Token.Pos);
    const nameStop = nameStart.translate({ characterDelta: name.length });
    const nameLoc = new Location(uri, new Range(nameStart, nameStop));

    const location = new Location(uri, new Range(createPosition(item.Keys[0].Token.Pos), endPosFromVal(item.Val)));

    return new Section("local", null, null, name, nameLoc, location, item, []);
}

function assignmentFromItemNode(uri: Uri, item: any): Reference {
    const name = item.Keys[0].Token.Text;

    const start = createPosition(item.Keys[0].Token.Pos);
    const end = endPosFromVal(item.Val);

    const location = new Location(uri, new Range(start, end));

    let reference = new Reference(`var.${name}`, location, null);
    reference.nameRange = new Range(start, start.translate({ characterDelta: name.length }));

    return reference;
}

function* walkHil(uri: Uri, exprs: any[], currentSection: Section): Iterable<Reference> {
    for (let expr of exprs) {
        if (expr.Name && expr.Posx) {
            let name = expr.Name as string;

            // for now ignore self. and count.
            if (name.startsWith("self.") || name.startsWith("count.")) {
                return;
            }
            let range = new Range(new Position(expr.Posx.Line - 1, expr.Posx.Column - 1),
                new Position(expr.Posx.Line - 1, expr.Posx.Column - 1 + name.length));
            let location = new Location(uri, range);
            let reference = new Reference(expr.Name, location, currentSection);
            yield reference;
        }
        // handle ternary
        if (expr.CondExpr) {
            yield* walkHil(uri, [expr.CondExpr, expr.TrueExpr, expr.FalseExpr], currentSection);
        }
        if (expr.Key) {
            yield* walkHil(uri, [expr.Key], currentSection);
        }
        if (expr.Target) {
            yield* walkHil(uri, [expr.Target], currentSection);
        }
        if (expr.Args) {
            yield* walkHil(uri, expr.Args as any[], currentSection);
        }
        if (expr.Op) {
            yield* walkHil(uri, expr.Exprs as any[], currentSection);
        }
    }
}

function extractReferencesFromHil(uri: Uri, token: any, currentSection: Section): [Reference[], ParseError] {
    let [hil, error] = parseHilWithPosition(token.Text, token.Pos.Column, token.Pos.Line, token.Filename);

    if (error) {
        return [null, new ParseError(token, error.message)];
    }

    if (!hil.Exprs) {
        // no expressions found in the HIL
        return [[], null];
    }

    return [[...walkHil(uri, hil.Exprs, currentSection)], null];
}

function childOfLocalsSection(p: VisitedNode[]): boolean {
    if (p.length < 3)
        return false;

    if (p[p.length - 3].type !== NodeType.Item)
        return false;

    const item = p[p.length - 3].node as AstItem;
    if (item.Keys.length === 0)
        return false;

    return item.Keys[0].Token.Text === "locals";
}

function parseRequiredVersion(requiredVersionStr: string, range: Range): [VersionRequirement, Diagnostic] {
    let requirement: VersionRequirement;
    let diagnostic: Diagnostic;
    try {
        requirement = VersionRequirement.parse(requiredVersionStr);
    } catch (err) {
        diagnostic = new Diagnostic(range, err.message, DiagnosticSeverity.ERROR);
    }

    return [requirement, diagnostic];
}

function terraformSectionFromItemNode(uri: Uri, node: AstItem): [TerraformSection, Diagnostic] {
    const requiredVersionVal = findValue(node, "required_version");
    const requiredVersionStr = getStringValue(requiredVersionVal, "", { stripQuotes: true });

    const start = createPosition(node.Keys[0].Token.Pos);
    const end = endPosFromVal(node.Val);

    const location = new Location(uri, new Range(start, end));

    if (requiredVersionStr !== "" && requiredVersionVal) {
        const [requirement, diagnostic] = parseRequiredVersion(requiredVersionStr, rangeFromVal(requiredVersionVal));

        const section = new TerraformSection(requiredVersionStr, requirement, location, node);
        return [section, diagnostic];
    } else {
        const section = new TerraformSection(requiredVersionStr, null, location, node);
        // Really cool idea but needs some refinement before we can annoy people into adding required_version
        // return [section, new Diagnostic(location.range, "terraform statement without a required_version attribute", DiagnosticSeverity.WARNING)];
        return [section, null];
    }
}

export function build(uri: Uri, ast: Ast): FileIndex {
    if (!ast) {
        throw "ast cannot be null";
    }

    let result = new FileIndex(uri);

    let currentSection: Section = null;
    let currentDepth = 0;
    walk(ast, (type, node, path, index, array) => {
        if (path.length === currentDepth && currentSection) {
            // push section into index
            currentDepth = 0;
            result.add(currentSection);

            currentSection = null;
        }

        if (type === NodeType.Item) {
            // detect variable assignments
            if (node.Keys.length === 1) {
                // handle top-level things
                if (path.length === 2) {
                    if (node.Keys[0].Token.Text === "terraform") {
                        let [terraformSection, diagnostic] = terraformSectionFromItemNode(uri, node as AstItem);
                        result.terraform = terraformSection;
                        if (diagnostic)
                            result.diagnostics.push(diagnostic);
                        return;
                    }

                    // assignment nodes (like we want) have an actual valid assignment
                    // position, whereas single key sections (like terraform, locals)
                    // do not
                    if (node.Assign.Line === 0 && node.Assign.Column === 0)
                        return;

                    // TODO: we should part move this parsing into a separate
                    //       parser which only handles tfvars files
                    // only top-level assignments
                    let assignment = assignmentFromItemNode(uri, node);
                    if (assignment) {
                        result.assignments.push(assignment);
                    }
                    return;
                } else {
                    if (childOfLocalsSection(path)) {
                        currentDepth = path.length;
                        currentSection = sectionFromSingleKeyItemNode(uri, node);
                        return;
                    }
                }
            }

            // detect section
            if (node.Keys.length === 2 || node.Keys.length === 3) {
                if (currentSection) {
                    result.add(currentSection);
                }

                currentDepth = path.length;
                currentSection = sectionFromKeyItemNode(uri, node);
                return;
            }
        }

        if (type === NodeType.Value) {
            // we can later use path to go up and detect what type
            // of value we are currently processing but right now we are
            // only using it to collect references
            //
            // the AST contains chains like this Val > Keys > Items > [Val > Token.Type==9]
            // we only care about the second Val in the above example, we use
            // Token.Type==9 to detect it
            // Token.Type==10 is for heredoc
            if (node.Token && (node.Token.Type === 9 || node.Token.Type === 10)) {
                if (!currentSection) {
                    // TODO: this happens in tfvars files, should probably handle those
                    return;
                }

                let [references, error] = extractReferencesFromHil(uri, node.Token, currentSection);

                if (error) {
                    const range = new Range(new Position(error.line, error.column), new Position(error.line, node.Token.Pos.Column - 1 + node.Token.Text.length));
                    let message = error.message;
                    if (!message) {
                        message = "Could not parse expression";
                    }

                    message = message.replace(/^parse error at undefined:[0-9]+:[0-9]+:\s+/, '');
                    const diagnostic = new Diagnostic(range, message, DiagnosticSeverity.ERROR);
                    result.diagnostics.push(diagnostic);
                    return;
                }

                currentSection.references.push(...references);
                return;
            }
        }
    });

    // handle last section
    if (currentSection) {
        result.add(currentSection);
    }

    return result;
}