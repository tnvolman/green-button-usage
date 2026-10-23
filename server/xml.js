"use strict";

/**
 * A small XML reader for Green Button Atom/ESPI documents.
 * It keeps element names, attributes, and text. Prefixes are preserved
 * on the element name; callers compare local names.
 * No network, no entity loader, no DTD.
 */

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isNameChar(c) {
  return c && !/\s/.test(c) && c !== "/" && c !== ">" && c !== "=";
}

function parseXml(input) {
  const s = String(input).replace(/^\uFEFF/, "");
  const n = s.length;
  let i = 0;

  function fail(message) {
    const err = new Error(message + " at offset " + i);
    err.code = "xml";
    throw err;
  }

  function skipSpace() {
    while (i < n && (s[i] === " " || s[i] === "\n" || s[i] === "\r" || s[i] === "\t")) i += 1;
  }

  function skipMisc() {
    while (i < n) {
      skipSpace();
      if (s.startsWith("<?", i)) {
        const j = s.indexOf("?>", i + 2);
        if (j < 0) fail("Unclosed processing instruction");
        i = j + 2;
        continue;
      }
      if (s.startsWith("<!--", i)) {
        const j = s.indexOf("-->", i + 4);
        if (j < 0) fail("Unclosed comment");
        i = j + 3;
        continue;
      }
      if (s.startsWith("<!", i)) {
        const j = s.indexOf(">", i + 2);
        if (j < 0) fail("Unclosed declaration");
        i = j + 1;
        continue;
      }
      break;
    }
  }

  function findTagEnd(from) {
    let quote = null;
    for (let j = from; j < n; j++) {
      const c = s[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === ">") return j;
    }
    fail("Unclosed tag");
  }

  function parseAttrs(raw) {
    const attrs = {};
    let p = 0;
    while (p < raw.length) {
      while (p < raw.length && /\s/.test(raw[p])) p += 1;
      if (p >= raw.length) break;
      const start = p;
      while (p < raw.length && isNameChar(raw[p])) p += 1;
      const name = raw.slice(start, p);
      if (!name) fail("Bad attribute name");
      while (p < raw.length && /\s/.test(raw[p])) p += 1;
      if (raw[p] !== "=") fail("Expected = after attribute " + name);
      p += 1;
      while (p < raw.length && /\s/.test(raw[p])) p += 1;
      const q = raw[p];
      if (q !== '"' && q !== "'") fail("Expected quoted attribute");
      const end = raw.indexOf(q, p + 1);
      if (end < 0) fail("Unclosed attribute value");
      attrs[name] = decodeEntities(raw.slice(p + 1, end));
      p = end + 1;
    }
    return attrs;
  }

  function parseElement() {
    if (s[i] !== "<") fail("Expected <");
    const gt = findTagEnd(i + 1);
    let raw = s.slice(i + 1, gt).trim();
    let selfClosing = false;
    if (raw.endsWith("/")) {
      selfClosing = true;
      raw = raw.slice(0, -1).trim();
    }
    const space = raw.search(/\s/);
    const name = space === -1 ? raw : raw.slice(0, space);
    if (!name || name.startsWith("/")) fail("Expected an element name");
    const attrs = space === -1 ? {} : parseAttrs(raw.slice(space));
    i = gt + 1;
    if (selfClosing) return { name, attrs, children: [] };

    const children = [];
    while (i < n) {
      if (s.startsWith("</", i)) {
        const closeEnd = s.indexOf(">", i + 2);
        if (closeEnd < 0) fail("Unclosed end tag");
        const closeName = s.slice(i + 2, closeEnd).trim();
        if (closeName !== name) fail("End tag " + closeName + " does not match " + name);
        i = closeEnd + 1;
        return { name, attrs, children };
      }
      if (s.startsWith("<!--", i)) {
        const j = s.indexOf("-->", i + 4);
        if (j < 0) fail("Unclosed comment");
        i = j + 3;
        continue;
      }
      if (s.startsWith("<?", i)) {
        const j = s.indexOf("?>", i + 2);
        if (j < 0) fail("Unclosed processing instruction");
        i = j + 2;
        continue;
      }
      if (s.startsWith("<![CDATA[", i)) {
        const j = s.indexOf("]]>", i + 9);
        if (j < 0) fail("Unclosed CDATA");
        children.push(s.slice(i + 9, j));
        i = j + 3;
        continue;
      }
      if (s[i] === "<") {
        children.push(parseElement());
        continue;
      }
      const next = s.indexOf("<", i);
      const end = next < 0 ? n : next;
      const text = decodeEntities(s.slice(i, end));
      if (text.trim() !== "") children.push(text);
      i = end;
    }
    fail("Missing end tag for " + name);
  }

  skipMisc();
  if (i >= n || s[i] !== "<") fail("Document is empty");
  const root = parseElement();
  skipMisc();
  if (i < n) fail("Unexpected trailing content");
  return root;
}

function localName(name) {
  const idx = String(name).lastIndexOf(":");
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

function childElements(el) {
  if (!el || !el.children) return [];
  return el.children.filter((child) => child && typeof child === "object");
}

function directText(el) {
  if (!el || !el.children) return "";
  let out = "";
  for (const child of el.children) {
    if (typeof child === "string") out += child;
  }
  return out.trim();
}

function firstChild(el, name) {
  for (const child of childElements(el)) {
    if (localName(child.name) === name) return child;
  }
  return null;
}

function childText(el, name) {
  const child = firstChild(el, name);
  return child ? directText(child) : "";
}

function integerText(text) {
  if (text == null) return null;
  const trimmed = String(text).trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

module.exports = {
  parseXml,
  localName,
  childElements,
  directText,
  firstChild,
  childText,
  integerText,
  decodeEntities,
};
