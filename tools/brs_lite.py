#!/usr/bin/env python3
"""A small BrightScript checker and interpreter, so Detox Home's code can be tested on a computer.

    python3 tools/brs_lite.py roku-app          # syntax-check every .brs file (a typo stops the app starting)

It understands the language Detox Home uses, and runs pure functions (no SceneGraph nodes): see
tools/test_site_search.py. It is deliberately stricter than a real Roku where they might differ:
`and` / `or` evaluate both sides, a string + a number is an error, reading an unset variable is an error,
and values passed to typed parameters are checked. Associative arrays ignore key case and list their keys in
sorted order, like a Roku's.
"""
import json
import os
import re
import sys
import urllib.parse


class BrsSyntaxError(Exception):
    pass


class BrsRuntimeError(Exception):
    pass


# --- Tokens -------------------------------------------------------------------------------------------

KEYWORDS = {"and", "or", "not", "mod", "if", "then", "else", "elseif", "endif", "end", "for", "to", "step", "each", "in",
            "next", "exit", "exitfor", "while", "endwhile", "exitwhile", "sub", "function", "endsub", "endfunction",
            "return", "true", "false", "invalid", "as", "print", "stop", "try", "catch", "endtry", "throw", "endfor"}
OPERATORS = ["<<=", ">>=", "<>", "<=", ">=", "<<", ">>", "+=", "-=", "*=", "/=", "\\=", "+", "-", "*", "/", "\\", "^", "=",
             "<", ">", "(", ")", "[", "]", "{", "}", ",", ".", ":", "?", ";"]
NUMBER_RE = re.compile(r"(\d+\.\d*|\.\d+|\d+)([eEdD][+-]?\d+)?[%!#&]?")
HEX_RE = re.compile(r"&[hH]([0-9a-fA-F]+)&?")
WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*[$%!#&]?")


class Token:
    __slots__ = ("kind", "value", "line")

    def __init__(self, kind, value, line):
        self.kind, self.value, self.line = kind, value, line

    def __repr__(self):
        return f"{self.kind}:{self.value!r}@{self.line}"


def tokenize(source, name="<code>"):
    tokens = []
    for number, line in enumerate(source.split("\n"), 1):
        i, n = 0, len(line)
        while i < n:
            ch = line[i]
            if ch in " \t\r":
                i += 1
            elif ch == "'":
                break
            elif ch == '"':
                i += 1
                out = []
                while True:
                    if i >= n:
                        raise BrsSyntaxError(f"{name}:{number}: a string isn't closed")
                    if line[i] == '"':
                        if i + 1 < n and line[i + 1] == '"':
                            out.append('"')
                            i += 2
                            continue
                        i += 1
                        break
                    out.append(line[i])
                    i += 1
                tokens.append(Token("string", "".join(out), number))
            elif HEX_RE.match(line, i):
                match = HEX_RE.match(line, i)
                tokens.append(Token("number", int(match.group(1), 16), number))
                i = match.end()
            elif ch.isdigit() or (ch == "." and i + 1 < n and line[i + 1].isdigit()):
                match = NUMBER_RE.match(line, i)
                text = match.group(0).rstrip("%!#&")
                is_float = "." in text or match.group(2) is not None
                tokens.append(Token("number", float(text.replace("d", "e").replace("D", "e")) if is_float else int(text), number))
                i = match.end()
            elif ch.isalpha() or ch == "_":
                match = WORD_RE.match(line, i)
                word = match.group(0)
                i = match.end()
                lower = word.lower()
                if lower == "rem" and (not tokens or tokens[-1].kind == "newline" or tokens[-1].value == ":"):
                    break
                tokens.append(Token("keyword" if lower in KEYWORDS else "word", lower if lower in KEYWORDS else word, number))
            else:
                for op in OPERATORS:
                    if line.startswith(op, i):
                        tokens.append(Token("op", op, number))
                        i += len(op)
                        break
                else:
                    raise BrsSyntaxError(f"{name}:{number}: unexpected character {ch!r}")
        tokens.append(Token("newline", "\n", number))
    tokens.append(Token("eof", "", len(source.split("\n"))))
    return tokens


# --- Parser (nodes are tuples: (kind, line, ...)) -----------------------------------------------------

TYPES = {"integer", "longinteger", "float", "double", "string", "boolean", "object", "dynamic", "function", "void"}
# Words a Roku reserves: they can't be variable names, even though they're fine after a dot or as a key.
RESERVED_NAMES = {"pos", "tab", "type", "run", "let", "dim", "goto", "line_num", "objfun", "rem"}


class Parser:
    def __init__(self, tokens, name):
        self.tokens, self.name, self.pos, self.depth = tokens, name, 0, 0

    @property
    def tok(self):
        return self.tokens[self.pos]

    def fail(self, message):
        raise BrsSyntaxError(f"{self.name}:{self.tok.line}: {message} (at {self.tok.value!r})")

    def advance(self):
        tok = self.tok
        self.pos += 1
        return tok

    def at(self, kind, value=None):
        return self.tok.kind == kind and (value is None or self.tok.value == value)

    def accept(self, kind, value=None):
        if self.at(kind, value):
            return self.advance()
        return None

    def expect(self, kind, value=None):
        if not self.at(kind, value):
            self.fail(f"expected {value or kind}")
        return self.advance()

    def skip_lines(self):
        while self.at("newline") or self.at("op", ":"):
            self.advance()

    def end_statement(self):
        if not (self.at("newline") or self.at("op", ":") or self.at("eof")):
            self.fail("expected the end of the line")

    def program(self):
        functions = {}
        self.skip_lines()
        while not self.at("eof"):
            if not (self.at("keyword", "function") or self.at("keyword", "sub")):
                self.fail("only functions and subs can be at the top of a file")
            fn = self.function()
            key = fn["name"].lower()
            if key in functions:
                self.fail(f"{fn['name']} is defined twice")
            functions[key] = fn
            self.skip_lines()
        return functions

    def function(self):
        kind = self.advance().value
        name = self.expect("word").value
        params = []
        self.expect("op", "(")
        while not self.at("op", ")"):
            param = self.expect("word").value.lower()
            if param in RESERVED_NAMES:
                self.fail(f"{param} is a reserved word on Roku")
            default = None
            if self.accept("op", "="):
                default = self.expression()
            ptype = "dynamic"
            if self.accept("keyword", "as"):
                ptype = self.type_name()
            params.append((param, default, ptype))
            if not self.accept("op", ","):
                break
        self.expect("op", ")")
        returns = "void" if kind == "sub" else "dynamic"
        if self.accept("keyword", "as"):
            returns = self.type_name()
        self.end_statement()
        body = self.block(self.closes(kind))
        self.close(kind)
        return {"name": name, "kind": kind, "params": params, "returns": returns, "body": body}

    def type_name(self):
        tok = self.advance()
        if tok.kind not in ("word", "keyword") or str(tok.value).lower() not in TYPES:
            self.pos -= 1
            self.fail("that isn't a type")
        return str(tok.value).lower()

    def closes(self, kind):
        return lambda: (self.at("keyword", "end") and self.peek_is(kind)) or self.at("keyword", "end" + kind)

    def peek_is(self, word):
        next_tok = self.tokens[self.pos + 1]
        return next_tok.kind == "keyword" and next_tok.value == word

    def close(self, kind):
        if self.accept("keyword", "end" + kind):
            return
        self.expect("keyword", "end")
        self.expect("keyword", kind)

    def block(self, stop):
        statements = []
        while True:
            self.skip_lines()
            if self.at("eof"):
                self.fail("the file ended inside a block")
            if stop():
                return statements
            statements.append(self.statement())

    def statement(self):
        tok = self.tok
        line = tok.line
        if tok.kind == "keyword":
            word = tok.value
            if word == "if":
                return self.if_statement()
            if word == "for":
                return self.for_statement()
            if word == "while":
                self.advance()
                cond = self.expression()
                self.end_statement()
                body = self.block(self.closes("while"))
                self.close("while")
                return ("while", line, cond, body)
            if word == "exit":
                self.advance()
                if not (self.accept("keyword", "for") or self.accept("keyword", "while")):
                    self.fail("expected exit for or exit while")
                return ("exit", line)
            if word in ("exitfor", "exitwhile"):
                self.advance()
                return ("exit", line)
            if word == "return":
                self.advance()
                value = None
                if not (self.at("newline") or self.at("op", ":") or self.at("eof") or self.at("keyword", "else")):
                    value = self.expression()
                return ("return", line, value)
            if word == "print":
                return self.print_statement()
            if word == "stop":
                self.advance()
                return ("stop", line)
            if word == "try":
                self.advance()
                self.end_statement()
                body = self.block(lambda: self.at("keyword", "catch"))
                self.expect("keyword", "catch")
                name = self.expect("word").value.lower()
                self.end_statement()
                handler = self.block(self.closes("try"))
                self.close("try")
                return ("try", line, body, name, handler)
            if word == "throw":
                self.advance()
                return ("throw", line, self.expression())
            self.fail("this word can't start a statement")
        if tok.kind == "op" and tok.value == "?":
            return self.print_statement()
        target = self.postfix()
        for op in ("=", "+=", "-=", "*=", "/=", "\\=", "<<=", ">>="):
            if self.at("op", op):
                if target[0] not in ("var", "member", "index"):
                    self.fail("can't assign to that")
                if target[0] == "var" and target[2] in RESERVED_NAMES:
                    self.fail(f"{target[2]} is a reserved word on Roku")
                self.advance()
                value = self.expression()
                if op != "=":
                    value = ("binary", line, op[:-1], target, value)
                return ("assign", line, target, value)
        if target[0] != "call":
            self.fail("this line doesn't do anything")
        return ("expr", line, target)

    def print_statement(self):
        line = self.advance().line
        items = []
        while not (self.at("newline") or self.at("op", ":") or self.at("eof")):
            if self.accept("op", ";") or self.accept("op", ","):
                continue
            items.append(self.expression())
        return ("print", line, items)

    def if_statement(self):
        line = self.advance().line
        cond = self.expression()
        had_then = bool(self.accept("keyword", "then"))
        if self.at("newline"):
            return self.multiline_if(line, cond)
        if self.at("op", ":") or not had_then:
            self.fail("write then, or start a new line, after the condition")
        then = self.inline_block()
        otherwise = []
        if self.accept("keyword", "else"):
            otherwise = self.inline_block()
        return ("if", line, [(cond, then)], otherwise)

    def inline_block(self):
        statements = [self.statement()]
        while self.accept("op", ":"):
            statements.append(self.statement())
        return statements

    def multiline_if(self, line, cond):
        clauses = []
        otherwise = []

        def stop():
            return self.at("keyword", "else") or self.at("keyword", "elseif") or self.at("keyword", "endif") or (self.at("keyword", "end") and self.peek_is("if"))

        body = self.block(stop)
        clauses.append((cond, body))
        while True:
            if self.accept("keyword", "elseif"):
                inner = self.expression()
                self.accept("keyword", "then")
                self.end_statement()
                clauses.append((inner, self.block(stop)))
            elif self.at("keyword", "else"):
                self.advance()
                if self.accept("keyword", "if"):
                    inner = self.expression()
                    self.accept("keyword", "then")
                    self.end_statement()
                    clauses.append((inner, self.block(stop)))
                else:
                    self.end_statement()
                    otherwise = self.block(stop)
                    if not (self.at("keyword", "endif") or (self.at("keyword", "end") and self.peek_is("if"))):
                        self.fail("expected end if")
            else:
                self.close("if")
                return ("if", line, clauses, otherwise)

    def for_statement(self):
        line = self.advance().line
        if self.accept("keyword", "each"):
            name = self.expect("word").value.lower()
            if name in RESERVED_NAMES:
                self.fail(f"{name} is a reserved word on Roku")
            self.expect("keyword", "in")
            items = self.expression()
            self.end_statement()
            body = self.block(self.for_ends)
            self.close_for()
            return ("foreach", line, name, items, body)
        name = self.expect("word").value.lower()
        self.expect("op", "=")
        start = self.expression()
        self.expect("keyword", "to")
        stop = self.expression()
        step = None
        if self.accept("keyword", "step"):
            step = self.expression()
        self.end_statement()
        body = self.block(self.for_ends)
        self.close_for()
        return ("for", line, name, start, stop, step, body)

    def for_ends(self):
        return self.at("keyword", "next") or self.at("keyword", "endfor") or (self.at("keyword", "end") and self.peek_is("for"))

    def close_for(self):
        if self.accept("keyword", "next"):
            self.accept("word")
        elif not self.accept("keyword", "endfor"):
            self.close("for")

    # Expressions, lowest precedence first.
    def expression(self):
        return self.or_expr()

    def or_expr(self):
        left = self.and_expr()
        while self.at("keyword", "or"):
            line = self.advance().line
            left = ("binary", line, "or", left, self.and_expr())
        return left

    def and_expr(self):
        left = self.not_expr()
        while self.at("keyword", "and"):
            line = self.advance().line
            left = ("binary", line, "and", left, self.not_expr())
        return left

    def not_expr(self):
        if self.at("keyword", "not"):
            line = self.advance().line
            return ("not", line, self.not_expr())
        return self.compare()

    def compare(self):
        left = self.shift()
        while self.tok.kind == "op" and self.tok.value in ("=", "<>", "<", ">", "<=", ">="):
            tok = self.advance()
            left = ("binary", tok.line, tok.value, left, self.shift())
        return left

    def shift(self):
        left = self.additive()
        while self.tok.kind == "op" and self.tok.value in ("<<", ">>"):
            tok = self.advance()
            left = ("binary", tok.line, tok.value, left, self.additive())
        return left

    def additive(self):
        left = self.term()
        while self.tok.kind == "op" and self.tok.value in ("+", "-"):
            tok = self.advance()
            left = ("binary", tok.line, tok.value, left, self.term())
        return left

    def term(self):
        left = self.unary()
        while (self.tok.kind == "op" and self.tok.value in ("*", "/", "\\")) or self.at("keyword", "mod"):
            tok = self.advance()
            left = ("binary", tok.line, tok.value, left, self.unary())
        return left

    def unary(self):
        if self.tok.kind == "op" and self.tok.value in ("-", "+"):
            tok = self.advance()
            operand = self.unary()
            return ("negate", tok.line, operand) if tok.value == "-" else operand
        return self.power()

    def power(self):
        left = self.postfix()
        while self.at("op", "^"):
            tok = self.advance()
            left = ("binary", tok.line, "^", left, self.unary())
        return left

    def postfix(self):
        node = self.primary()
        while True:
            if self.at("op", "."):
                line = self.advance().line
                tok = self.advance()
                if tok.kind not in ("word", "keyword"):
                    self.pos -= 1
                    self.fail("expected a name after the dot")
                node = ("member", line, node, str(tok.value))
            elif self.at("op", "["):
                line = self.advance().line
                index = self.expression()
                self.expect("op", "]")
                node = ("index", line, node, index)
            elif self.at("op", "("):
                line = self.advance().line
                args = []
                while not self.at("op", ")"):
                    args.append(self.expression())
                    if not self.accept("op", ","):
                        break
                self.expect("op", ")")
                node = ("call", line, node, args)
            else:
                return node

    def primary(self):
        tok = self.tok
        line = tok.line
        if tok.kind == "number" or tok.kind == "string":
            self.advance()
            return ("literal", line, tok.value)
        if tok.kind == "keyword" and tok.value in ("true", "false"):
            self.advance()
            return ("literal", line, tok.value == "true")
        if tok.kind == "keyword" and tok.value == "invalid":
            self.advance()
            return ("literal", line, INVALID)
        if tok.kind == "word":
            self.advance()
            return ("var", line, tok.value.lower())
        if self.accept("op", "("):
            inner = self.expression()
            self.expect("op", ")")
            return inner
        if self.accept("op", "["):
            items = []
            self.skip_newlines()
            while not self.at("op", "]"):
                items.append(self.expression())
                self.skip_newlines()
                if self.accept("op", ","):
                    self.skip_newlines()
                elif not self.at("op", "]") and self.tokens[self.pos - 1].kind != "newline":
                    self.fail("expected a comma or ]")
            self.expect("op", "]")
            return ("array", line, items)
        if self.accept("op", "{"):
            pairs = []
            self.skip_newlines()
            while not self.at("op", "}"):
                key = self.advance()
                if key.kind not in ("word", "keyword", "string"):
                    self.pos -= 1
                    self.fail("expected a key")
                self.expect("op", ":")
                pairs.append((str(key.value), self.expression()))
                self.skip_newlines()
                if self.accept("op", ","):
                    self.skip_newlines()
                elif not self.at("op", "}") and self.tokens[self.pos - 1].kind != "newline":
                    self.fail("expected a comma or }")
            self.expect("op", "}")
            return ("aa", line, pairs)
        self.fail("expected a value")

    def skip_newlines(self):
        while self.at("newline"):
            self.advance()


def parse(source, name="<code>"):
    return Parser(tokenize(source, name), name).program()


# --- Values -------------------------------------------------------------------------------------------

class Invalid:
    def __repr__(self):
        return "invalid"

    def __bool__(self):
        return False


INVALID = Invalid()


class BrsArray(list):
    pass


class BrsAA:
    """Keys ignore case unless SetModeCaseSensitive is called; they're listed in sorted order."""

    def __init__(self):
        self.items, self.sensitive = {}, False

    def key(self, name):
        return name if self.sensitive else name.lower()

    def get(self, name):
        entry = self.items.get(self.key(name))
        return entry[1] if entry else INVALID

    def set(self, name, value):
        self.items[self.key(name)] = (name, value)

    def has(self, name):
        return self.key(name) in self.items

    def delete(self, name):
        return self.items.pop(self.key(name), None) is not None

    def sorted_keys(self):
        return [self.items[k][0] for k in sorted(self.items)]


class BrsRegex:
    def __init__(self, pattern, flags):
        options = 0
        for flag in flags:
            options |= {"i": re.I, "m": re.M, "s": re.S, "x": re.X}.get(flag, 0)
        self.compiled = re.compile(pattern, options | re.ASCII)  # a Roku's \w and \s are ASCII unless asked otherwise

    @staticmethod
    def groups(match):
        return BrsArray([match.group(0)] + [g if g is not None else "" for g in match.groups()])


class BrsByteArray(list):
    pass


def from_python(value):
    if value is None:
        return INVALID
    if isinstance(value, dict):
        out = BrsAA()
        for k, v in value.items():
            out.set(str(k), from_python(v))
        return out
    if isinstance(value, (list, tuple)):
        return BrsArray(from_python(v) for v in value)
    return value


def to_python(value):
    if value is INVALID:
        return None
    if isinstance(value, BrsAA):
        return {entry[0]: to_python(entry[1]) for entry in value.items.values()}
    if isinstance(value, BrsArray):
        return [to_python(v) for v in value]
    return value


def type_of(value):
    if value is INVALID:
        return "Invalid"
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, int):
        return "Integer"
    if isinstance(value, float):
        return "Float"
    if isinstance(value, str):
        return "String"
    if isinstance(value, BrsArray):
        return "roArray"
    if isinstance(value, BrsAA):
        return "roAssociativeArray"
    if isinstance(value, BrsRegex):
        return "roRegex"
    if isinstance(value, BrsByteArray):
        return "roByteArray"
    return "Function"


class ReturnSignal(Exception):
    def __init__(self, value):
        self.value = value


class ExitLoop(Exception):
    pass


ACCEPTS = {
    "string": ("String",),
    "integer": ("Integer", "Float"),
    "longinteger": ("Integer", "Float"),
    "float": ("Integer", "Float"),
    "double": ("Integer", "Float"),
    "boolean": ("Boolean",),
    "object": ("Invalid", "roArray", "roAssociativeArray", "roRegex", "roByteArray", "String", "Integer", "Float", "Boolean"),
}


class Interpreter:
    def __init__(self, paths, max_steps=200_000_000):
        self.functions = {}
        for path in paths:
            with open(path, encoding="utf-8") as handle:
                found = parse(handle.read(), os.path.basename(path))
            for key, fn in found.items():
                if key in self.functions:
                    raise BrsSyntaxError(f"{path}: {fn['name']} is defined in two files")
                self.functions[key] = fn
        self.m = BrsAA()
        self.steps, self.max_steps = 0, max_steps

    def call(self, name, *args):
        return to_python(self.invoke(self.functions[name.lower()], [from_python(a) for a in args], 0))

    def invoke(self, fn, args, line):
        where = f"{fn['name']} (called on line {line})"
        if len(args) > len(fn["params"]):
            raise BrsRuntimeError(f"{where}: too many arguments")
        scope = {"m": self.m}
        for i, (name, default, ptype) in enumerate(fn["params"]):
            if i < len(args):
                value = args[i]
            elif default is not None:
                value = self.evaluate(default, scope)
            else:
                raise BrsRuntimeError(f"{where}: missing argument {name}")
            if ptype in ACCEPTS and type_of(value) not in ACCEPTS[ptype]:
                raise BrsRuntimeError(f"{where}: {name} must be {ptype}, got {type_of(value)}")
            scope[name] = value
        try:
            self.run(fn["body"], scope)
            result = INVALID
            returned = False
        except ReturnSignal as signal:
            result, returned = signal.value, True
        if fn["returns"] == "void":
            return INVALID
        if not returned:
            raise BrsRuntimeError(f"{where}: reached the end without returning a value")
        if fn["returns"] in ACCEPTS and type_of(result) not in ACCEPTS[fn["returns"]]:
            raise BrsRuntimeError(f"{where}: must return {fn['returns']}, returned {type_of(result)}")
        return result

    def run(self, statements, scope):
        for statement in statements:
            self.steps += 1
            if self.steps > self.max_steps:
                raise BrsRuntimeError("the program ran too long")
            self.execute(statement, scope)

    def execute(self, node, scope):
        kind, line = node[0], node[1]
        try:
            if kind == "assign":
                value = self.evaluate(node[3], scope)
                self.store(node[2], value, scope)
            elif kind == "expr":
                self.evaluate(node[2], scope)
            elif kind == "if":
                for cond, body in node[2]:
                    if self.truth(self.evaluate(cond, scope), line):
                        self.run(body, scope)
                        return
                self.run(node[3], scope)
            elif kind == "foreach":
                items = self.evaluate(node[3], scope)
                if isinstance(items, BrsAA):
                    items = items.sorted_keys()
                elif not isinstance(items, (BrsArray, BrsByteArray)):
                    raise BrsRuntimeError(f"can't loop over {type_of(items)}")
                try:
                    for item in list(items):
                        scope[node[2]] = item
                        self.run(node[4], scope)
                except ExitLoop:
                    pass
            elif kind == "for":
                current = self.evaluate(node[3], scope)
                stop = self.evaluate(node[4], scope)
                step = self.evaluate(node[5], scope) if node[5] is not None else 1
                scope[node[2]] = current
                try:
                    while (scope[node[2]] <= stop) if step >= 0 else (scope[node[2]] >= stop):
                        self.run(node[6], scope)
                        scope[node[2]] = scope[node[2]] + step
                except ExitLoop:
                    pass
            elif kind == "while":
                try:
                    while self.truth(self.evaluate(node[2], scope), line):
                        self.steps += 1
                        self.run(node[3], scope)
                except ExitLoop:
                    pass
            elif kind == "exit":
                raise ExitLoop()
            elif kind == "return":
                raise ReturnSignal(self.evaluate(node[2], scope) if node[2] is not None else INVALID)
            elif kind == "print":
                for item in node[2]:
                    self.evaluate(item, scope)
            elif kind == "stop":
                raise BrsRuntimeError("reached a stop statement")
            elif kind == "throw":
                raise BrsRuntimeError(str(to_python(self.evaluate(node[2], scope))))
            elif kind == "try":
                try:
                    self.run(node[2], scope)
                except BrsRuntimeError as err:
                    error = BrsAA()
                    error.set("message", str(err))
                    scope[node[3]] = error
                    self.run(node[4], scope)
            else:
                raise BrsRuntimeError(f"unknown statement {kind}")
        except BrsRuntimeError as err:
            if " [line " not in str(err):
                raise BrsRuntimeError(f"{err} [line {line}]") from None
            raise

    def store(self, target, value, scope):
        kind = target[0]
        if kind == "var":
            scope[target[2]] = value
        elif kind == "member":
            holder = self.evaluate(target[2], scope)
            if not isinstance(holder, BrsAA):
                raise BrsRuntimeError(f"can't set .{target[3]} on {type_of(holder)}")
            holder.set(target[3], value)
        else:
            holder = self.evaluate(target[2], scope)
            index = self.evaluate(target[3], scope)
            if isinstance(holder, BrsAA) and isinstance(index, str):
                holder.set(index, value)
            elif isinstance(holder, BrsArray) and isinstance(index, int):
                while len(holder) <= index:
                    holder.append(INVALID)
                holder[index] = value
            else:
                raise BrsRuntimeError(f"can't index {type_of(holder)} with {type_of(index)}")

    @staticmethod
    def truth(value, line):
        if not isinstance(value, bool):
            raise BrsRuntimeError(f"a condition must be true or false, got {type_of(value)}")
        return value

    def evaluate(self, node, scope):
        kind = node[0]
        if kind == "literal":
            return node[2]
        if kind == "var":
            name = node[2]
            if name in scope:
                return scope[name]
            if name in self.functions:
                return self.functions[name]
            if name in BUILTINS:
                return BUILTINS[name]
            raise BrsRuntimeError(f"{name} is used before it's set")
        if kind == "binary":
            return self.binary(node[2], self.evaluate(node[3], scope), self.evaluate(node[4], scope))
        if kind == "not":
            value = self.evaluate(node[2], scope)
            if not isinstance(value, bool):
                raise BrsRuntimeError(f"not needs true or false, got {type_of(value)}")
            return not value
        if kind == "negate":
            value = self.evaluate(node[2], scope)
            if type_of(value) not in ("Integer", "Float"):
                raise BrsRuntimeError(f"can't negate {type_of(value)}")
            return -value
        if kind == "array":
            return BrsArray(self.evaluate(item, scope) for item in node[2])
        if kind == "aa":
            out = BrsAA()
            for key, value in node[2]:
                out.set(key, self.evaluate(value, scope))
            return out
        if kind == "member":
            holder = self.evaluate(node[2], scope)
            if isinstance(holder, BrsAA):
                return holder.get(node[3])
            raise BrsRuntimeError(f"can't read .{node[3]} of {type_of(holder)}")
        if kind == "index":
            holder = self.evaluate(node[2], scope)
            index = self.evaluate(node[3], scope)
            if isinstance(holder, BrsAA) and isinstance(index, str):
                return holder.get(index)
            if isinstance(holder, (BrsArray, BrsByteArray)) and isinstance(index, int):
                return holder[index] if 0 <= index < len(holder) else INVALID
            raise BrsRuntimeError(f"can't index {type_of(holder)} with {type_of(index)}")
        if kind == "call":
            return self.call_node(node, scope)
        raise BrsRuntimeError(f"unknown expression {kind}")

    def call_node(self, node, scope):
        callee, line = node[2], node[1]
        if callee[0] == "member":
            holder = self.evaluate(callee[2], scope)
            args = [self.evaluate(a, scope) for a in node[3]]
            if isinstance(holder, BrsAA) and holder.has(callee[3]) and isinstance(holder.get(callee[3]), dict):
                return self.invoke(holder.get(callee[3]), args, line)
            return call_method(holder, callee[3].lower(), args)
        target = self.evaluate(callee, scope)
        args = [self.evaluate(a, scope) for a in node[3]]
        if isinstance(target, dict):
            return self.invoke(target, args, line)
        if callable(target):
            return target(*args)
        raise BrsRuntimeError(f"can't call {type_of(target)}")

    @staticmethod
    def binary(op, a, b):
        ta, tb = type_of(a), type_of(b)
        numeric = ta in ("Integer", "Float") and tb in ("Integer", "Float")
        if op in ("and", "or"):
            if ta == "Integer" and tb == "Integer":  # on whole numbers they work bit by bit
                return (a & b) if op == "and" else (a | b)
            if ta != "Boolean" or tb != "Boolean":
                raise BrsRuntimeError(f"{op} needs true or false, got {ta} and {tb}")
            return (a and b) if op == "and" else (a or b)
        if op in ("=", "<>"):
            if a is INVALID or b is INVALID:
                same = a is b
            elif numeric or ta == tb:
                if ta not in ("Integer", "Float", "String", "Boolean"):
                    raise BrsRuntimeError(f"can't compare {ta} values")
                same = a == b
            else:
                raise BrsRuntimeError(f"can't compare {ta} with {tb}")
            return same if op == "=" else not same
        if op in ("<", ">", "<=", ">="):
            if not (numeric or (ta == "String" and tb == "String")):
                raise BrsRuntimeError(f"can't order {ta} and {tb}")
            return {"<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]
        if op == "+" and ta == "String" and tb == "String":
            return a + b
        if not numeric:
            raise BrsRuntimeError(f"can't use {op} on {ta} and {tb}")
        both_int = ta == "Integer" and tb == "Integer"
        if op == "+":
            out = a + b
        elif op == "-":
            out = a - b
        elif op == "*":
            out = a * b
        elif op == "/":
            if b == 0:
                raise BrsRuntimeError("divide by zero")
            return float(a) / float(b)
        elif op == "\\":
            if b == 0:
                raise BrsRuntimeError("divide by zero")
            return int(a / b)
        elif op == "mod":
            return int(a) - int(b) * int(int(a) / int(b))
        elif op == "^":
            return float(a) ** float(b)
        elif op == "<<":
            out = int(a) << int(b)
        elif op == ">>":
            out = int(a) >> int(b)
        else:
            raise BrsRuntimeError(f"unknown operator {op}")
        if both_int:
            out = ((out + 2**31) % 2**32) - 2**31
        return out


# --- Built-in functions and methods --------------------------------------------------------------------

def need(value, wanted, what):
    if type_of(value) not in wanted:
        raise BrsRuntimeError(f"{what} needs {' or '.join(wanted)}, got {type_of(value)}")
    return value


def text(value, what):
    return need(value, ("String",), what)


def whole(value, what):
    return int(need(value, ("Integer", "Float"), what))


def brs_mid(s, start, count=None):
    s, start = text(s, "Mid"), whole(start, "Mid")
    if start < 1:
        raise BrsRuntimeError("Mid starts at 1")
    return s[start - 1:] if count is None else s[start - 1:start - 1 + max(0, whole(count, "Mid"))]


def brs_instr(start, s, sub):
    start = max(whole(start, "Instr"), 1)
    return text(s, "Instr").find(text(sub, "Instr"), start - 1) + 1


def brs_val(s, radix=10):
    s = text(s, "Val").strip()
    if radix != 10:
        try:
            return int(s, radix)
        except ValueError:
            return 0
    match = re.match(r"[+-]?(\d+\.?\d*|\.\d+)", s)
    if not match:
        return 0
    number = float(match.group(0))
    return int(number) if number.is_integer() else number


def brs_parse_json(source, flags=""):
    try:
        value = json.loads(text(source, "ParseJson"))
    except ValueError:
        return INVALID
    return from_python(value)


def brs_chr(code):
    code = whole(code, "Chr")
    return chr(code) if 0 <= code <= 0x10FFFF else ""


def brs_create(name, *args):
    lower = text(name, "CreateObject").lower()
    if lower == "roregex":
        try:
            return BrsRegex(text(args[0], "roRegex"), text(args[1], "roRegex"))
        except re.error as err:
            raise BrsRuntimeError(f"bad pattern {args[0]!r}: {err}") from None
    if lower == "roassociativearray":
        return BrsAA()
    if lower == "roarray":
        return BrsArray()
    if lower == "robytearray":
        return BrsByteArray()
    raise BrsRuntimeError(f"CreateObject({name}) isn't available when running on a computer")


BUILTINS = {
    "len": lambda s: len(text(s, "Len")),
    "mid": brs_mid,
    "left": lambda s, n: text(s, "Left")[:max(0, whole(n, "Left"))],
    "right": lambda s, n: (text(s, "Right")[-whole(n, "Right"):] if whole(n, "Right") > 0 else ""),
    "instr": brs_instr,
    "lcase": lambda s: text(s, "LCase").lower(),
    "ucase": lambda s: text(s, "UCase").upper(),
    "chr": brs_chr,
    "asc": lambda s: ord(text(s, "Asc")[0]) if s else 0,
    "str": lambda n: (" " if n >= 0 else "") + str(n),
    "val": brs_val,
    "int": lambda n: int(n // 1),
    "fix": lambda n: int(n),
    "abs": abs,
    "parsejson": brs_parse_json,
    "formatjson": lambda v, flags=0: json.dumps(to_python(v), separators=(",", ":"), ensure_ascii=False),
    "createobject": brs_create,
    "type": lambda v, version=0: type_of(v),
    "box": lambda v: v,
}


def call_method(holder, name, args):
    kind = type_of(holder)
    if kind == "String":
        return string_method(holder, name, args)
    if kind in ("Integer", "Float") and name == "tostr":
        return str(holder)
    if kind == "roArray":
        return array_method(holder, name, args)
    if kind == "roAssociativeArray":
        return aa_method(holder, name, args)
    if kind == "roRegex":
        return regex_method(holder, name, args)
    if kind == "roByteArray":
        return bytes_method(holder, name, args)
    raise BrsRuntimeError(f"{kind} has no method {name}")


def string_method(s, name, args):
    if name == "len":
        return len(s)
    if name == "trim":
        return s.strip(" \t\r\n\f\v")
    if name == "tostr":
        return s
    if name == "toint":
        match = re.match(r"\s*[+-]?\d+", s)
        return int(match.group(0)) if match else 0
    if name == "left":
        return s[:max(0, args[0])]
    if name == "right":
        return s[-args[0]:] if args[0] > 0 else ""
    if name == "mid":  # counts from 0, unlike the Mid() function
        return s[args[0]:] if len(args) == 1 else s[args[0]:args[0] + max(0, args[1])]
    if name == "instr":  # counts from 0, -1 if not found
        return s.find(args[0]) if len(args) == 1 else s.find(args[1], args[0])
    if name == "split":
        if args[0] == "":
            return BrsArray(s)
        return BrsArray(s.split(args[0]) if s else [])
    if name == "replace":
        return s.replace(text(args[0], "Replace"), text(args[1], "Replace"))
    if name == "startswith":
        return s.startswith(text(args[0], "StartsWith"))
    if name == "endswith":
        return s.endswith(text(args[0], "EndsWith"))
    if name == "encodeuricomponent":
        return urllib.parse.quote(s, safe="-_.!~*'()")
    if name == "decodeuricomponent":
        try:
            return urllib.parse.unquote(s, errors="strict")
        except UnicodeDecodeError:
            return ""
    raise BrsRuntimeError(f"String has no method {name}")


def array_method(arr, name, args):
    if name == "push":
        arr.append(args[0])
        return INVALID
    if name == "pop":
        return arr.pop() if arr else INVALID
    if name == "count":
        return len(arr)
    if name == "clear":
        arr.clear()
        return INVALID
    if name == "append":
        arr.extend(need(args[0], ("roArray",), "Append"))
        return INVALID
    if name == "join":
        for item in arr:
            text(item, "Join")
        return args[0].join(arr)
    if name == "sort":
        arr.sort(key=(str.lower if args and "i" in args[0] else None))
        return INVALID
    raise BrsRuntimeError(f"roArray has no method {name}")


def aa_method(aa, name, args):
    if name == "setmodecasesensitive":
        aa.sensitive = True
        return INVALID
    if name == "count":
        return len(aa.items)
    if name == "keys":
        return BrsArray(aa.sorted_keys())
    if name == "doesexist":
        return aa.has(text(args[0], "DoesExist"))
    if name == "lookup":
        return aa.get(text(args[0], "Lookup"))
    if name == "addreplace":
        aa.set(text(args[0], "AddReplace"), args[1])
        return INVALID
    if name == "delete":
        return aa.delete(text(args[0], "Delete"))
    raise BrsRuntimeError(f"roAssociativeArray has no method {name}")


def regex_method(rx, name, args):
    s = text(args[0], "roRegex")
    if name == "ismatch":
        return rx.compiled.search(s) is not None
    if name == "match":
        match = rx.compiled.search(s)
        return BrsRegex.groups(match) if match else BrsArray()
    if name == "matchall":
        return BrsArray(BrsRegex.groups(m) for m in rx.compiled.finditer(s))
    if name in ("replace", "replaceall"):
        replacement = text(args[1], "roRegex")
        return rx.compiled.sub(lambda m: re.sub(r"\\(\d)", lambda g: m.group(int(g.group(1))) or "", replacement), s, count=0 if name == "replaceall" else 1)
    if name == "split":
        return BrsArray(rx.compiled.split(s))
    raise BrsRuntimeError(f"roRegex has no method {name}")


def bytes_method(ba, name, args):
    if name == "fromasciistring":
        ba[:] = text(args[0], "FromAsciiString").encode("utf-8")
        return INVALID
    if name == "count":
        return len(ba)
    if name == "toasciistring":
        return bytes(ba).decode("utf-8", "replace")
    raise BrsRuntimeError(f"roByteArray has no method {name}")


def check_folder(folder):
    problems = []
    count = 0
    for root, _, names in os.walk(folder):
        for name in sorted(names):
            if name.endswith(".brs"):
                count += 1
                path = os.path.join(root, name)
                try:
                    with open(path, encoding="utf-8") as handle:
                        parse(handle.read(), path)
                except BrsSyntaxError as err:
                    problems.append(str(err))
    return count, problems


# The functions a Roku provides everywhere.
GLOBAL_FUNCTIONS = {"createobject", "type", "wait", "int", "fix", "abs", "sgn", "val", "str", "stri", "left", "mid", "right", "len", "instr",
                    "lcase", "ucase", "chr", "asc", "string", "stringi", "substitute", "parsejson", "formatjson", "readasciifile", "writeasciifile",
                    "deletefile", "copyfile", "movefile", "listdir", "matchfiles", "createdirectory", "box", "getglobalaa", "uptime", "sleep", "tr",
                    "rnd", "strtoi", "getinterface", "findmemberfunction", "sin", "cos", "tan", "atn", "exp", "log", "sqr", "csng", "cdbl"}
CALLBACK_METHODS = {"observefield", "observefieldscoped"}


def walk(node):
    """Every tuple node inside a parsed statement or expression."""
    if isinstance(node, tuple):
        if node and isinstance(node[0], str):
            yield node
        for item in node:
            yield from walk(item)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)


def check_scripts(label, paths, callbacks=()):
    """One component's scripts together: nothing defined twice, no call to a function that doesn't exist, and every
    callback named in a string is real. (On a Roku the first stops it compiling; the others fail when they're reached, or silently.)"""
    functions, problems = {}, []
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            for key, fn in parse(handle.read(), path).items():
                if key in functions:
                    problems.append(f"{label}: {fn['name']} is defined twice")
                functions[key] = fn
    for name in callbacks:
        if name.lower() not in functions:
            problems.append(f"{label}: the callback {name} doesn't exist")
    for key, fn in functions.items():
        local = {param[0] for param in fn["params"]} | {"m"}
        nodes = list(walk(fn["body"]))
        for node in nodes:
            if node[0] == "assign" and node[2][0] == "var":
                local.add(node[2][2])
            elif node[0] in ("for", "foreach"):
                local.add(node[2])
            elif node[0] == "try":
                local.add(node[3])
        for node in nodes:
            if node[0] == "var" and node[2] not in local and node[2] not in functions and node[2] not in GLOBAL_FUNCTIONS:
                problems.append(f"{label}: {fn['name']} (line {node[1]}) uses {node[2]}, which is never set")
            if node[0] == "call" and node[2][0] == "member" and node[2][3].lower() in CALLBACK_METHODS and len(node[3]) == 2 and node[3][1][0] == "literal":
                if str(node[3][1][2]).lower() not in functions:
                    problems.append(f"{label}: {fn['name']} (line {node[1]}) observes with {node[3][1][2]}, which doesn't exist")
            if node[0] == "assign" and node[2][0] == "member" and node[2][3].lower() == "functionname" and node[3][0] == "literal":
                if str(node[3][2]).lower() not in functions:
                    problems.append(f"{label}: functionName {node[3][2]} doesn't exist")
    return problems


def check_app(folder):
    """check_scripts for every component (its XML says which scripts it uses) and for source/."""
    import xml.etree.ElementTree as ET
    problems = []
    components = os.path.join(folder, "components")
    names = {f[:-4] for f in os.listdir(components) if f.endswith(".xml")}
    for name in sorted(names):
        path = os.path.join(components, name + ".xml")
        root = ET.parse(path).getroot()
        scripts = [os.path.join(folder, s.get("uri").replace("pkg:/", "")) for s in root.findall("script")]
        missing = [s for s in scripts if not os.path.exists(s)]
        problems += [f"{name}: {s} doesn't exist" for s in missing]
        callbacks = [field.get("onChange") for field in root.iter("field") if field.get("onChange")]
        if not missing:
            problems += check_scripts(name, scripts, callbacks)
        for element in root.iter():
            item = element.get("itemComponentName")
            if item and item not in names:
                problems.append(f"{name}: itemComponentName {item} doesn't exist")
    source = os.path.join(folder, "source")
    problems += check_scripts("source", [os.path.join(source, f) for f in sorted(os.listdir(source)) if f.endswith(".brs")])
    return problems


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "roku-app"
    total, errors = check_folder(folder)
    if not errors:
        errors = check_app(folder)
    for error in errors:
        print(error)
    print(f"{total} files checked, {len(errors)} problems.")
    sys.exit(1 if errors else 0)
