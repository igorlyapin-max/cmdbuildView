import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CMDBUILD_URL = "http://127.0.0.1:8090/cmdbuild/services/rest/v3";
const REQUEST_TIMEOUT_MS = 20000;
const SYSTEM_ATTRIBUTE_NAMES = new Set(["Id", "IdClass", "IdTenant"]);
const ANCHOR_SAFE_RE = /[^A-Za-z0-9_-]+/g;
const JS_LOCALE_ENTRY_RE = /(?<![\w$])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'((?:\\'|[^'])*)'/g;
const DEFAULT_LANGUAGE = "en";
const PORT = Number(process.env.PORT || 8001);
const HOST = process.env.HOST || "0.0.0.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

const LANGUAGES = [
  { code: "ar", description: "العربية" },
  { code: "bg", description: "Български" },
  { code: "cs", description: "Čeština" },
  { code: "da", description: "Dansk" },
  { code: "de", description: "Deutsch" },
  { code: "el_GR", description: "Ελληνικά" },
  { code: "en", description: "English" },
  { code: "es", description: "Español" },
  { code: "fa", description: "Persian" },
  { code: "fr", description: "Français" },
  { code: "hr", description: "Hrvatski" },
  { code: "hu", description: "Hungarian" },
  { code: "id", description: "Bahasa Indonesia" },
  { code: "it", description: "Italiano" },
  { code: "ja", description: "日本語" },
  { code: "ko", description: "한국어" },
  { code: "mn", description: "Монгол" },
  { code: "ms", description: "Bahasa Melayu" },
  { code: "nl", description: "Nederlands" },
  { code: "no", description: "Norsk" },
  { code: "pl", description: "Polski" },
  { code: "pt_BR", description: "Português Brasil" },
  { code: "pt_PT", description: "Português Portugal" },
  { code: "ro", description: "Română" },
  { code: "ru", description: "Русский" },
  { code: "sk", description: "Slovenčina" },
  { code: "sl", description: "Slovenščina" },
  { code: "sr", description: "Srpski" },
  { code: "sr_RS", description: "Српски" },
  { code: "th", description: "ภาษาไทย" },
  { code: "tr", description: "Türkçe" },
  { code: "ua", description: "Українська" },
  { code: "vn", description: "Tiếng Việt" },
  { code: "zh_CN", description: "中文" }
];
const LANGUAGE_CODES = new Set(LANGUAGES.map((language) => language.code));

class CmdbuildError extends Error {
  constructor(message, statusCode = null, details = null) {
    super(message);
    this.name = "CmdbuildError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function normalizeBaseUrl(rawUrl) {
  const value = String(rawUrl || DEFAULT_CMDBUILD_URL).trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_CMDBUILD_URL;
  if (value.endsWith("/services/rest/v3")) return value;
  if (value.endsWith("/cmdbuild")) return `${value}/services/rest/v3`;
  return `${value}/cmdbuild/services/rest/v3`;
}

function normalizeLanguage(rawLanguage) {
  const language = String(rawLanguage || DEFAULT_LANGUAGE).trim();
  return LANGUAGE_CODES.has(language) ? language : DEFAULT_LANGUAGE;
}

function makeAnchor(prefix, value) {
  const slug = String(value || "").trim().replace(ANCHOR_SAFE_RE, "-").replace(/^-+|-+$/g, "");
  return `${prefix}-${slug || "item"}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attr(value) {
  return escapeHtml(value);
}

function parseCookies(req) {
  const cookies = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    let decodedValue = decodeURIComponent(value);
    if (decodedValue.length >= 2 && decodedValue.startsWith('"') && decodedValue.endsWith('"')) {
      decodedValue = decodedValue.slice(1, -1);
    }
    cookies[key] = decodedValue;
  }
  return cookies;
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", "HttpOnly"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function clearCookieHeader(name) {
  return `${name}=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0`;
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return Object.fromEntries(new URLSearchParams(body));
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function redirect(res, target, setCookies = []) {
  res.writeHead(303, {
    Location: target,
    ...(setCookies.length ? { "Set-Cookie": setCookies } : {})
  });
  res.end();
}

async function cmdbuildRequest(baseUrl, requestPath, options = {}) {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${String(requestPath).replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(options.params || {})) {
    url.searchParams.set(key, value);
  }

  const headers = { Accept: "application/json" };
  if (options.token) headers["CMDBuild-Authorization"] = options.token;
  if (options.language) headers["Accept-Language"] = options.language;

  let body;
  if (options.payload !== undefined) {
    body = JSON.stringify(options.payload);
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new CmdbuildError(`Could not connect to CMDBuild: ${error.message}`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new CmdbuildError(`CMDBuild returned HTTP ${response.status}`, response.status, raw);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CmdbuildError("CMDBuild returned a non-JSON response", null, raw.slice(0, 500));
  }

  if (data?.success === false) {
    const message = Array.isArray(data.messages) && data.messages[0]?.message
      ? data.messages[0].message
      : "CMDBuild rejected the request";
    throw new CmdbuildError(message, null, data);
  }
  return data;
}

async function loadTranslationMap(baseUrl, token, language) {
  try {
    const result = await cmdbuildRequest(baseUrl, "translations", {
      token,
      language,
      params: { scope: "service", limit: "100000" }
    });
    const translations = {};
    for (const item of result.data || []) {
      if (item.lang === language && item.code && item.value) translations[item.code] = item.value;
    }
    return translations;
  } catch {
    return {};
  }
}

function uiBaseUrlFromRest(baseUrl) {
  const suffix = "/services/rest/v3";
  const value = baseUrl.replace(/\/+$/, "");
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function parseJsLocaleLabels(rawLocale) {
  const labels = {};
  for (const match of rawLocale.matchAll(JS_LOCALE_ENTRY_RE)) {
    const key = match[1].toLowerCase();
    if (!labels[key]) labels[key] = match[2].replaceAll("\\'", "'");
  }
  return labels;
}

async function loadUiLocaleLabels(baseUrl, language) {
  if (!language || language === DEFAULT_LANGUAGE) return {};
  const uiBaseUrl = uiBaseUrlFromRest(baseUrl);
  const labels = {};
  for (const localePath of [
    `ui/app/locales/${encodeURIComponent(language)}/Locales.js`,
    `ui/app/locales/${encodeURIComponent(language)}/LocalesAdministration.js`
  ]) {
    try {
      const response = await fetch(`${uiBaseUrl}/${localePath}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) continue;
      const parsed = parseJsLocaleLabels(await response.text());
      for (const [key, value] of Object.entries(parsed)) {
        if (!labels[key]) labels[key] = value;
      }
    } catch {
      continue;
    }
  }
  return labels;
}

function templateLabels(uiLabels) {
  return {
    active: uiLabels.active || "Active",
    attributes: uiLabels.attributes || "Attributes",
    cardinality: uiLabels.cardinality || "Cardinality",
    code: uiLabels.code || "Code",
    description: uiLabels.description || "Description",
    destination: uiLabels.destination || "Destination",
    direct: uiLabels.direct || "Direct",
    domain: uiLabels.domain || "Domain",
    help_text: uiLabels.helptext || uiLabels.help || "Help text",
    inverse: uiLabels.inverse || "Inverse",
    name: uiLabels.name || "Name",
    note: uiLabels.note || "Note",
    origin: uiLabels.origin || uiLabels.source || "Origin",
    type: uiLabels.type || "Type",
    value: uiLabels.value || "Value"
  };
}

function translatedValue(translations, ...codes) {
  for (const code of codes) {
    if (code && translations[code]) return translations[code];
  }
  return "";
}

function translatedDescription(item, translations, codes, fallbackName = "") {
  return translatedValue(translations, ...codes)
    || item?._description_translation
    || item?.description
    || fallbackName;
}

function localizedFieldLabel(rawName, metadataDescription, uiLabels) {
  const normalizedName = String(rawName || "").toLowerCase();
  const normalizedDescription = String(metadataDescription || "").toLowerCase();
  if (metadataDescription && normalizedDescription !== normalizedName) {
    return uiLabels[normalizedDescription] || metadataDescription;
  }
  return uiLabels[normalizedName] || metadataDescription || rawName;
}

function isSystemAttribute(attribute) {
  return SYSTEM_ATTRIBUTE_NAMES.has(attribute?.name) || attribute?.mode === "syshidden" || attribute?.mode === "sysreadonly";
}

function normalizeAttribute(attribute, translations, uiLabels, ownerName = "") {
  const lookupType = attribute.lookupType || "";
  const name = attribute.name || "";
  const metadataDescription = translatedDescription(
    attribute,
    translations,
    [
      `attribute.${ownerName}.${name}.description`,
      `class.${ownerName}.attribute.${name}.description`,
      `domain.${ownerName}.attribute.${name}.description`
    ],
    name
  );
  const displayName = localizedFieldLabel(name, metadataDescription, uiLabels);
  return {
    name,
    display_name: displayName,
    type: attribute.type || "",
    description: displayName,
    help_text: attribute.help || "",
    inherited: Boolean(attribute.inherited),
    lookup_type: lookupType,
    lookup_anchor: lookupType ? makeAnchor("lookup", lookupType) : ""
  };
}

async function loadClassAttributes(baseUrl, token, className, translations, uiLabels, language) {
  const result = await cmdbuildRequest(baseUrl, `classes/${encodeURIComponent(className)}/attributes`, {
    token,
    language,
    params: { scope: "service", limit: "500" }
  });
  const ownAttributes = [];
  const inheritedAttributes = [];
  for (const rawAttribute of result.data || []) {
    if (isSystemAttribute(rawAttribute)) continue;
    const attribute = normalizeAttribute(rawAttribute, translations, uiLabels, className);
    if (attribute.inherited) inheritedAttributes.push(attribute);
    else ownAttributes.push(attribute);
  }
  return [ownAttributes, inheritedAttributes];
}

function registerLookupUsage(lookupIndex, classItem, attribute) {
  const lookupType = attribute.lookup_type;
  const className = classItem.name;
  if (!lookupType || !className) return;
  if (!lookupIndex[lookupType]) {
    lookupIndex[lookupType] = {
      name: lookupType,
      anchor: makeAnchor("lookup", lookupType),
      usages_by_class: {}
    };
  }
  const lookup = lookupIndex[lookupType];
  if (!lookup.usages_by_class[className]) {
    lookup.usages_by_class[className] = {
      class_name: className,
      class_display_name: classItem.display_name || className,
      class_anchor: classItem.anchor || makeAnchor("class", className),
      attributes: []
    };
  }
  lookup.usages_by_class[className].attributes.push({
    name: attribute.name || "",
    display_name: attribute.display_name || attribute.name || "",
    inherited: Boolean(attribute.inherited)
  });
}

function lookupValueKey(value) {
  return `${String(value.description || "").toLowerCase()}\0${String(value.code || "").toLowerCase()}`;
}

function lookupValueId(value) {
  return String(value._id ?? value.id ?? value.code ?? "");
}

function lookupParentId(value) {
  let parent = value.parent;
  if (parent && typeof parent === "object") parent = parent._id ?? parent.id;
  if (parent === undefined || parent === null) parent = value.parent_id;
  return parent === undefined || parent === null ? null : String(parent);
}

function buildLookupHierarchy(rawValues, lookupName, translations) {
  const values = [];
  const byId = {};
  const childrenByParent = {};
  for (const rawValue of rawValues) {
    const valueId = lookupValueId(rawValue);
    const code = rawValue.code || "";
    const description = translatedDescription(
      rawValue,
      translations,
      [`lookup.${lookupName}.${code}.description`],
      code || valueId
    );
    const value = {
      id: valueId,
      code,
      description,
      parent_id: lookupParentId(rawValue),
      note: rawValue.note || "",
      active: rawValue.active,
      index: rawValue.index,
      level: 0,
      has_children: false
    };
    values.push(value);
    byId[valueId] = value;
  }
  for (const value of values) {
    let parentId = value.parent_id;
    if (!byId[parentId]) parentId = "";
    childrenByParent[parentId] ||= [];
    childrenByParent[parentId].push(value);
  }
  for (const children of Object.values(childrenByParent)) {
    children.sort((left, right) => lookupValueKey(left).localeCompare(lookupValueKey(right)));
  }
  const ordered = [];
  const visited = new Set();
  const visit = (value, level) => {
    if (visited.has(value.id)) return;
    visited.add(value.id);
    value.level = level;
    const children = childrenByParent[value.id] || [];
    value.has_children = children.length > 0;
    ordered.push(value);
    for (const child of children) visit(child, level + 1);
  };
  for (const root of childrenByParent[""] || []) visit(root, 0);
  for (const value of [...values].sort((left, right) => lookupValueKey(left).localeCompare(lookupValueKey(right)))) {
    if (!visited.has(value.id)) visit(value, 0);
  }
  return [ordered, ordered.some((value) => value.level > 0 || value.has_children)];
}

function lookupSortLabel(lookup) {
  return String(lookup.description || lookup.name || "").toLowerCase();
}

function sortLookupNamesByParent(lookupIndex) {
  const childrenByParent = {};
  for (const [lookupName, lookup] of Object.entries(lookupIndex)) {
    let parent = lookup.parent;
    if (!lookupIndex[parent]) parent = "";
    childrenByParent[parent] ||= [];
    childrenByParent[parent].push(lookupName);
  }
  for (const children of Object.values(childrenByParent)) {
    children.sort((left, right) => lookupSortLabel(lookupIndex[left]).localeCompare(lookupSortLabel(lookupIndex[right])));
  }
  for (const [lookupName, lookup] of Object.entries(lookupIndex)) {
    lookup.has_children = Boolean(childrenByParent[lookupName]?.length);
  }
  const ordered = [];
  const visited = new Set();
  const visit = (lookupName, level) => {
    if (visited.has(lookupName)) return;
    visited.add(lookupName);
    lookupIndex[lookupName].hierarchy_level = level;
    ordered.push(lookupName);
    for (const childName of childrenByParent[lookupName] || []) visit(childName, level + 1);
  };
  for (const rootName of childrenByParent[""] || []) visit(rootName, 0);
  for (const lookupName of Object.keys(lookupIndex).sort((left, right) => lookupSortLabel(lookupIndex[left]).localeCompare(lookupSortLabel(lookupIndex[right])))) {
    if (!visited.has(lookupName)) visit(lookupName, 0);
  }
  return ordered;
}

async function loadDomains(baseUrl, token, classAnchors, classLabels, translations, uiLabels, language) {
  const result = await cmdbuildRequest(baseUrl, "domains", {
    token,
    language,
    params: { scope: "service", limit: "1000" }
  });
  const domains = [];
  const rawDomains = [...(result.data || [])].sort((left, right) => String(left.description || left.name || "").toLowerCase().localeCompare(String(right.description || right.name || "").toLowerCase()));
  for (const rawDomain of rawDomains) {
    const domainName = rawDomain.name || rawDomain._id;
    if (!domainName) continue;
    let domain = rawDomain;
    try {
      const detail = await cmdbuildRequest(baseUrl, `domains/${encodeURIComponent(domainName)}`, {
        token,
        language,
        params: { scope: "service" }
      });
      domain = detail.data || rawDomain;
    } catch {
      domain = rawDomain;
    }
    const source = domain.source || "";
    const destination = domain.destination || "";
    const sources = domain.sources || (source ? [source] : []);
    const destinations = domain.destinations || (destination ? [destination] : []);
    const sourceLinks = sources.filter(Boolean).map((className) => ({
      name: className,
      display_name: classLabels[className] || className,
      anchor: classAnchors[className] || ""
    }));
    const destinationLinks = destinations.filter(Boolean).map((className) => ({
      name: className,
      display_name: classLabels[className] || className,
      anchor: classAnchors[className] || ""
    }));
    let attributes = [];
    let attributesError = null;
    try {
      const attributesResult = await cmdbuildRequest(baseUrl, `domains/${encodeURIComponent(domainName)}/attributes`, {
        token,
        language,
        params: { scope: "service", limit: "1000" }
      });
      attributes = (attributesResult.data || [])
        .filter((rawAttribute) => !isSystemAttribute(rawAttribute))
        .map((rawAttribute) => normalizeAttribute(rawAttribute, translations, uiLabels, domainName));
    } catch (error) {
      attributesError = error.message;
    }
    const description = translatedDescription(domain, translations, [`domain.${domainName}.description`], domainName);
    const descriptionDirect = translatedValue(translations, `domain.${domainName}.descriptionDirect`, `domain.${domainName}.direct`)
      || domain._descriptionDirect_translation
      || domain.descriptionDirect
      || "";
    const descriptionInverse = translatedValue(translations, `domain.${domainName}.descriptionInverse`, `domain.${domainName}.inverse`)
      || domain._descriptionInverse_translation
      || domain.descriptionInverse
      || "";
    domains.push({
      name: domainName,
      display_name: description,
      anchor: makeAnchor("domain", domainName),
      attributes_anchor: `${makeAnchor("domain", domainName)}-attributes`,
      description,
      source,
      source_anchor: classAnchors[source] || "",
      source_links: sourceLinks,
      source_names: sources,
      destination,
      destination_anchor: classAnchors[destination] || "",
      destination_links: destinationLinks,
      destination_names: destinations,
      cardinality: domain.cardinality || "",
      description_direct: descriptionDirect,
      description_inverse: descriptionInverse,
      is_master_detail: Boolean(domain.isMasterDetail),
      active: domain.active,
      attributes,
      attributes_error: attributesError
    });
  }
  return domains;
}

function attachDomainsToClasses(classes, domains) {
  const classesByName = Object.fromEntries(classes.filter((item) => item.name).map((item) => [item.name, item]));
  for (const classItem of classes) classItem.related_domains = [];
  for (const domain of domains) {
    const relatedNames = new Set([...(domain.source_names || []), ...(domain.destination_names || [])]);
    for (const className of relatedNames) {
      if (!classesByName[className]) continue;
      classesByName[className].related_domains.push({
        name: domain.name,
        display_name: domain.display_name || domain.name,
        anchor: domain.anchor,
        description: domain.description || "",
        source_links: domain.source_links || [],
        destination_links: domain.destination_links || [],
        cardinality: domain.cardinality || "",
        attributes_anchor: domain.attributes_anchor,
        attributes_count: (domain.attributes || []).length
      });
    }
  }
}

async function loadLookupTables(baseUrl, token, lookupIndex, translations, language) {
  const result = await cmdbuildRequest(baseUrl, "lookup_types", {
    token,
    language,
    params: { scope: "service", limit: "1000" }
  });
  for (const rawLookup of result.data || []) {
    const lookupName = rawLookup.name || rawLookup._id;
    if (!lookupName) continue;
    lookupIndex[lookupName] ||= {
      name: lookupName,
      anchor: makeAnchor("lookup", lookupName),
      usages_by_class: {}
    };
    lookupIndex[lookupName].description = rawLookup.description || "";
    lookupIndex[lookupName].parent = rawLookup.parent || null;
    lookupIndex[lookupName].speciality = rawLookup.speciality || "";
    lookupIndex[lookupName].access_type = rawLookup.accessType || "";
  }
  const lookupTables = [];
  for (const lookupName of sortLookupNamesByParent(lookupIndex)) {
    const lookup = lookupIndex[lookupName];
    const parent = lookup.parent;
    const usages = Object.values(lookup.usages_by_class || {}).sort((left, right) => left.class_name.toLowerCase().localeCompare(right.class_name.toLowerCase()));
    const table = {
      name: lookupName,
      display_name: translatedValue(translations, `lookup.${lookupName}.description`) || lookup.description || lookupName,
      description: translatedValue(translations, `lookup.${lookupName}.description`) || lookup.description || "",
      parent: lookupIndex[parent] ? parent : "",
      parent_anchor: lookupIndex[parent] ? makeAnchor("lookup", parent) : "",
      parent_display_name: lookupIndex[parent]
        ? translatedValue(translations, `lookup.${parent}.description`) || lookupIndex[parent].description || parent || ""
        : "",
      hierarchy_level: lookup.hierarchy_level || 0,
      has_children: Boolean(lookup.has_children),
      speciality: lookup.speciality || "",
      access_type: lookup.access_type || "",
      anchor: lookup.anchor,
      usages,
      values: [],
      is_hierarchical: false,
      values_error: null
    };
    try {
      const valuesResult = await cmdbuildRequest(baseUrl, `lookup_types/${encodeURIComponent(lookupName)}/values`, {
        token,
        language,
        params: { scope: "service", limit: "1000" }
      });
      [table.values, table.is_hierarchical] = buildLookupHierarchy(valuesResult.data || [], lookupName, translations);
    } catch (error) {
      table.values_error = error.message;
    }
    lookupTables.push(table);
  }
  return lookupTables;
}

function classSortLabel(classItem) {
  return String(classItem.description || classItem.name || "").toLowerCase();
}

function getHierarchyLevel(classItem, byName) {
  let level = 0;
  const seen = new Set();
  let parent = classItem.parent;
  while (byName[parent] && !seen.has(parent)) {
    seen.add(parent);
    level += 1;
    parent = byName[parent].parent;
  }
  return level;
}

function sortClassesByInheritance(classes) {
  const byName = Object.fromEntries(classes.filter((item) => item.name).map((item) => [item.name, item]));
  const childrenByParent = {};
  for (const classItem of classes) {
    let parent = classItem.parent;
    if (!byName[parent]) parent = "";
    childrenByParent[parent] ||= [];
    childrenByParent[parent].push(classItem);
  }
  for (const children of Object.values(childrenByParent)) {
    children.sort((left, right) => classSortLabel(left).localeCompare(classSortLabel(right)));
  }
  for (const classItem of classes) {
    classItem.has_children = Boolean(classItem.name && childrenByParent[classItem.name]?.length);
  }
  const ordered = [];
  const visited = new Set();
  const visit = (classItem) => {
    const className = classItem.name;
    if (className && visited.has(className)) return;
    if (className) visited.add(className);
    classItem.hierarchy_level = getHierarchyLevel(classItem, byName);
    ordered.push(classItem);
    for (const child of childrenByParent[className] || []) visit(child);
  };
  for (const root of childrenByParent[""] || []) visit(root);
  for (const classItem of [...classes].sort((left, right) => classSortLabel(left).localeCompare(classSortLabel(right)))) {
    if (!classItem.name || !visited.has(classItem.name)) visit(classItem);
  }
  return ordered;
}

async function loadClassesWithAttributes(baseUrl, token, language) {
  const translations = await loadTranslationMap(baseUrl, token, language);
  const uiLabels = await loadUiLocaleLabels(baseUrl, language);
  const result = await cmdbuildRequest(baseUrl, "classes", {
    token,
    language,
    params: { scope: "service", limit: "500" }
  });
  const classes = sortClassesByInheritance(result.data || []);
  const classAnchors = {};
  const classLabels = {};
  const lookupIndex = {};
  for (const classItem of classes) {
    const className = classItem.name;
    if (className) classAnchors[className] = makeAnchor("class", className);
  }
  for (const classItem of classes) {
    const className = classItem.name;
    classItem.anchor = classAnchors[className] || makeAnchor("class", className || "");
    classItem.parent_anchor = classAnchors[classItem.parent] || "";
    classItem.display_name = translatedDescription(classItem, translations, className ? [`class.${className}.description`] : [], className || "");
    classLabels[className] = classItem.display_name;
    classItem.own_attributes = [];
    classItem.inherited_attributes = [];
    classItem.display_attributes = [];
    classItem.attributes_error = null;
    classItem.is_superclass = Boolean(classItem.prototype);
    if (!className) {
      classItem.attributes_error = "Class has no name.";
      continue;
    }
    try {
      const [ownAttributes, inheritedAttributes] = await loadClassAttributes(baseUrl, token, className, translations, uiLabels, language);
      classItem.own_attributes = ownAttributes;
      classItem.inherited_attributes = inheritedAttributes;
      classItem.display_attributes = ownAttributes;
      for (const attribute of [...inheritedAttributes, ...ownAttributes]) {
        registerLookupUsage(lookupIndex, classItem, attribute);
      }
    } catch (error) {
      classItem.attributes_error = error.message;
    }
  }
  for (const classItem of classes) {
    classItem.parent_display_name = classLabels[classItem.parent] || classItem.parent || "";
  }
  const lookupTables = await loadLookupTables(baseUrl, token, lookupIndex, translations, language);
  const domains = await loadDomains(baseUrl, token, classAnchors, classLabels, translations, uiLabels, language);
  attachDomainsToClasses(classes, domains);
  return { classes, lookup_tables: lookupTables, domains, labels: templateLabels(uiLabels) };
}

function renderLayout(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/styles.css?v=node-20260428">
  </head>
  <body>
    <main class="page">${body}</main>
  </body>
</html>`;
}

function renderLogin({ error = "", cmdbuildUrl = DEFAULT_CMDBUILD_URL }) {
  return renderLayout("CMDBuild login", `
<section class="auth-shell">
  <div class="auth-panel">
    <div class="panel-header">
      <p class="eyebrow">CMDBuild REST v3 · Node.js</p>
      <h1>Login</h1>
    </div>
    ${error ? `<div class="alert" role="alert">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/login" class="form">
      <label><span>CMDBuild API URL</span><input name="cmdbuild_url" type="url" value="${attr(cmdbuildUrl)}" required></label>
      <label><span>Username</span><input name="username" type="text" autocomplete="username" required></label>
      <label><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Log in and load classes</button>
    </form>
  </div>
</section>`);
}

function renderLanguageSwitcher(language) {
  return `<form method="post" action="/language" class="language-switcher">
    <input type="hidden" name="next" value="/classes">
    <label>
      <span>Language</span>
      <select name="language" onchange="this.form.submit()" aria-label="Display language">
        ${LANGUAGES.map((item) => `<option value="${attr(item.code)}" ${item.code === language ? "selected" : ""}>${escapeHtml(item.description)}</option>`).join("")}
      </select>
    </label>
    <button class="button secondary compact language-submit" type="submit">Apply</button>
  </form>`;
}

function renderAttributeRows(attributes) {
  return attributes.map((attributeItem) => `<tr class="${attributeItem.inherited ? "inherited-attribute-row" : ""}">
    <td>${attributeItem.lookup_type
      ? `<a class="attribute-lookup-link" href="#${attr(attributeItem.lookup_anchor)}"><code>${escapeHtml(attributeItem.display_name)}</code></a><span class="attribute-lookup-type">${escapeHtml(attributeItem.lookup_type)}</span>`
      : `<code>${escapeHtml(attributeItem.display_name)}</code>`}
      ${attributeItem.inherited ? `<span class="attribute-origin">inherited</span>` : ""}
    </td>
    <td>${escapeHtml(attributeItem.type)}</td>
    <td>${escapeHtml(attributeItem.description)}</td>
    <td>${escapeHtml(attributeItem.help_text || "—")}</td>
  </tr>`).join("");
}

function renderClassDomains(classItem, labels) {
  if (!classItem.related_domains?.length) return "";
  return `<div class="class-domains">
    <div class="class-domains-title">Class domains</div>
    <div class="table-wrap class-domains-wrap">
      <table class="class-domains-table">
        <thead><tr><th>${escapeHtml(labels.domain)}</th><th>${escapeHtml(labels.origin)}</th><th>${escapeHtml(labels.destination)}</th><th>${escapeHtml(labels.cardinality)}</th><th>${escapeHtml(labels.attributes)}</th></tr></thead>
        <tbody>${classItem.related_domains.map((domain) => `<tr>
          <td><a href="#${attr(domain.anchor)}"><code>${escapeHtml(domain.display_name)}</code></a>${domain.display_name !== domain.name ? `<span class="domain-description">${escapeHtml(domain.name)}</span>` : ""}</td>
          <td>${renderClassLinks(domain.source_links)}</td>
          <td>${renderClassLinks(domain.destination_links)}</td>
          <td>${escapeHtml(domain.cardinality || "—")}</td>
          <td>${domain.attributes_count ? `<a href="#${attr(domain.attributes_anchor)}">Attributes: ${domain.attributes_count}</a>` : `<span class="muted small">No attributes</span>`}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>
  </div>`;
}

function renderClassLinks(items) {
  return `<div class="domain-class-links">${(items || []).map((item) => item.anchor
    ? `<a href="#${attr(item.anchor)}">${escapeHtml(item.display_name)}</a>`
    : `<span>${escapeHtml(item.display_name)}</span>`).join("")}</div>`;
}

function renderClassPanel(classItem, labels) {
  return `<section id="${attr(classItem.anchor)}" class="class-panel hierarchy-level-${attr(classItem.hierarchy_level)} ${classItem.is_superclass ? "superclass-panel" : ""}" data-class-name="${attr(classItem.name)}" data-parent-name="${attr(classItem.parent || "")}" data-tree-panel="class" data-tree-name="${attr(classItem.name)}">
    <header class="class-header">
      <h2>${escapeHtml(classItem.display_name)}</h2>
      ${classItem.is_superclass ? `<span class="badge">Superclass</span>` : ""}
      <p>${escapeHtml(labels.code)}: ${escapeHtml(classItem.name)} · Level: ${escapeHtml(classItem.hierarchy_level)}
      ${classItem.parent ? ` · Parent: <a href="#${attr(classItem.parent_anchor)}">${escapeHtml(classItem.parent_display_name)}</a>` : ""}
      · ${escapeHtml(labels.active)}: ${classItem.active ? "Yes" : "No"}</p>
    </header>
    ${classItem.attributes_error ? `<div class="inline-error">${escapeHtml(classItem.attributes_error)}</div>` : ""}
    ${classItem.inherited_attributes?.length ? `<details class="inherited-details">
      <summary>Inherited attributes: ${classItem.inherited_attributes.length}</summary>
      <div class="table-wrap class-table-wrap"><table class="attributes-table class-attributes-table inherited-table">
        <thead><tr><th>${escapeHtml(labels.name)}</th><th>${escapeHtml(labels.type)}</th><th>${escapeHtml(labels.description)}</th><th>${escapeHtml(labels.help_text)}</th></tr></thead>
        <tbody>${renderAttributeRows(classItem.inherited_attributes)}</tbody>
      </table></div>
    </details>` : ""}
    ${classItem.own_attributes?.length ? `<div class="table-wrap class-table-wrap"><table class="attributes-table class-attributes-table">
      <thead><tr><th>${escapeHtml(labels.name)}</th><th>${escapeHtml(labels.type)}</th><th>${escapeHtml(labels.description)}</th><th>${escapeHtml(labels.help_text)}</th></tr></thead>
      <tbody>${renderAttributeRows(classItem.own_attributes)}</tbody>
    </table></div>` : `<div class="muted small">No own attributes</div>`}
    ${renderClassDomains(classItem, labels)}
  </section>`;
}

function renderSidebar(classes, lookupTables, domains) {
  return `<aside class="hierarchy-sidebar">
    <div class="sidebar-header">
      <nav class="sidebar-nav" aria-label="Page sections"><a href="#classes">Classes</a><a href="#lookups">Lookups</a><a href="#domains">Domains</a></nav>
      <button type="button" class="button secondary compact" id="show-all-classes">All</button>
    </div>
    <div class="hierarchy-list">
      <div class="sidebar-section-title"><button type="button" class="tree-toggle section-toggle" data-section-toggle="class" aria-expanded="true">−</button><a href="#classes">Classes</a></div>
      ${classes.map((classItem) => `<div class="hierarchy-item ${classItem.is_superclass ? "superclass-item" : ""}" style="--level: ${attr(classItem.hierarchy_level)}" data-sidebar-section="class" data-tree-row="class" data-tree-name="${attr(classItem.name)}" data-tree-parent="${attr(classItem.parent || "")}">
        <button type="button" class="tree-toggle" data-tree-toggle="class" data-tree-name="${attr(classItem.name)}" aria-label="Collapse ${attr(classItem.display_name)}" aria-expanded="true" ${!classItem.has_children ? "disabled" : ""}>−</button>
        <a href="#${attr(classItem.anchor)}">${escapeHtml(classItem.display_name)}</a>
      </div>`).join("")}
      ${lookupTables.length ? `<div class="sidebar-section-title"><button type="button" class="tree-toggle section-toggle" data-section-toggle="lookup" aria-expanded="true">−</button><a href="#lookups">Lookups</a></div>
      ${lookupTables.map((lookup) => `<div class="hierarchy-item lookup-menu-item" style="--level: ${attr(lookup.hierarchy_level)}" data-sidebar-section="lookup" data-tree-row="lookup" data-tree-name="${attr(lookup.name)}" data-tree-parent="${attr(lookup.parent || "")}">
        <button type="button" class="tree-toggle" data-tree-toggle="lookup" data-tree-name="${attr(lookup.name)}" aria-label="Collapse ${attr(lookup.display_name)}" aria-expanded="true" ${!lookup.has_children ? "disabled" : ""}>−</button>
        <a href="#${attr(lookup.anchor)}">${escapeHtml(lookup.display_name)}</a>
      </div>`).join("")}` : ""}
      ${domains.length ? `<div class="sidebar-section-title"><button type="button" class="tree-toggle section-toggle" data-section-toggle="domain" aria-expanded="true">−</button><a href="#domains">Domains</a></div>
      ${domains.map((domain) => `<div class="hierarchy-item domain-menu-item" style="--level: 0" data-sidebar-section="domain" data-tree-row="domain" data-tree-name="${attr(domain.name)}" data-tree-parent="">
        <button type="button" class="tree-toggle" disabled aria-hidden="true">−</button><a href="#${attr(domain.anchor)}">${escapeHtml(domain.display_name)}</a>
      </div>`).join("")}` : ""}
    </div>
  </aside>`;
}

function renderDomains(domains, labels) {
  return `<section id="domains" class="domains-section" aria-labelledby="domains-section-title">
    <header class="domains-section-header"><h2 id="domains-section-title">Domains</h2><p class="muted">CMDBuild class relations.</p></header>
    ${domains.length ? `<div class="table-wrap domains-table-wrap"><table class="domains-table">
      <thead><tr><th>${escapeHtml(labels.domain)}</th><th>${escapeHtml(labels.description)}</th><th>${escapeHtml(labels.origin)}</th><th>${escapeHtml(labels.destination)}</th><th>${escapeHtml(labels.cardinality)}</th><th>${escapeHtml(labels.direct)}</th><th>${escapeHtml(labels.inverse)}</th><th>${escapeHtml(labels.active)}</th></tr></thead>
      <tbody>${domains.map((domain) => `<tr id="${attr(domain.anchor)}" data-tree-panel="domain" data-tree-name="${attr(domain.name)}">
        <td><code>${escapeHtml(domain.display_name)}</code>${domain.display_name !== domain.name ? `<span class="domain-description">${escapeHtml(domain.name)}</span>` : ""}</td>
        <td>${escapeHtml(domain.description || "—")}</td><td>${renderClassLinks(domain.source_links)}</td><td>${renderClassLinks(domain.destination_links)}</td>
        <td>${escapeHtml(domain.cardinality || "—")}</td><td>${escapeHtml(domain.description_direct || "—")}</td><td>${escapeHtml(domain.description_inverse || "—")}</td><td>${domain.active === true ? "Yes" : domain.active === false ? "No" : "—"}</td>
      </tr><tr id="${attr(domain.attributes_anchor)}" class="domain-attributes-row" data-tree-panel="domain" data-tree-name="${attr(domain.name)}"><td colspan="8">
        ${domain.attributes_error ? `<div class="inline-error">${escapeHtml(domain.attributes_error)}</div>` : domain.attributes?.length ? `<div class="domain-attributes-title">Domain attributes</div><div class="table-wrap domain-attributes-wrap"><table class="domain-attributes-table">
          <thead><tr><th>${escapeHtml(labels.name)}</th><th>${escapeHtml(labels.type)}</th><th>${escapeHtml(labels.description)}</th><th>${escapeHtml(labels.help_text)}</th></tr></thead><tbody>${renderAttributeRows(domain.attributes)}</tbody>
        </table></div>` : `<span class="muted small">No domain attributes.</span>`}
      </td></tr>`).join("")}</tbody></table></div>` : `<div class="muted small">No domains found.</div>`}
  </section>`;
}

function renderLookups(lookupTables, labels) {
  if (!lookupTables.length) return "";
  return `<section id="lookups" class="lookup-section" aria-labelledby="lookup-section-title">
    <header class="lookup-section-header"><h2 id="lookup-section-title">Lookup</h2><p class="muted">Lookup tables used by class and domain attributes.</p></header>
    <div class="lookup-grid">${lookupTables.map((lookup) => `<article id="${attr(lookup.anchor)}" class="lookup-panel lookup-hierarchy-level-${attr(lookup.hierarchy_level)}" data-tree-panel="lookup" data-tree-name="${attr(lookup.name)}" data-tree-parent="${attr(lookup.parent || "")}">
      <header class="lookup-header"><h3>${escapeHtml(lookup.display_name)}</h3>${lookup.display_name !== lookup.name ? `<p class="muted">${escapeHtml(labels.code)}: ${escapeHtml(lookup.name)}</p>` : ""}${lookup.parent ? `<p class="muted">Parent: <a href="#${attr(lookup.parent_anchor)}">${escapeHtml(lookup.parent_display_name)}</a></p>` : ""}${lookup.is_hierarchical ? `<span class="badge">Hierarchical</span>` : ""}${lookup.description ? `<p class="muted">${escapeHtml(lookup.description)}</p>` : ""}</header>
      <div class="table-wrap lookup-meta-wrap"><table class="lookup-meta-table"><tbody><tr><th>Used by classes</th><td><div class="lookup-usage-list">${lookup.usages?.length ? lookup.usages.map((usage) => `<span class="lookup-usage-item"><a href="#${attr(usage.class_anchor)}">${escapeHtml(usage.class_display_name)}</a><span class="lookup-usage-attrs">(${escapeHtml(usage.attributes.map((item) => item.display_name).join(", "))})</span></span>`).join("") : `<span class="muted small">Not used by classes.</span>`}</div></td></tr><tr><th>${escapeHtml(labels.type)}</th><td>${escapeHtml(lookup.speciality || "default")}${lookup.access_type ? ` · ${escapeHtml(lookup.access_type)}` : ""}</td></tr></tbody></table></div>
      ${lookup.values_error ? `<div class="inline-error lookup-error">${escapeHtml(lookup.values_error)}</div>` : lookup.values?.length ? `<div class="table-wrap lookup-values-wrap"><table class="lookup-values-table">
        <thead><tr><th>${escapeHtml(labels.value)}</th><th>${escapeHtml(labels.code)}</th><th>${escapeHtml(labels.note)}</th><th>${escapeHtml(labels.active)}</th></tr></thead>
        <tbody>${lookup.values.map((value) => `<tr class="${value.level > 0 ? "lookup-child-row" : ""}"><td><span class="lookup-value-name ${value.has_children ? "lookup-value-parent" : ""}" style="--lookup-level: ${attr(value.level)}">${escapeHtml(value.description)}</span></td><td><code>${escapeHtml(value.code)}</code></td><td>${escapeHtml(value.note || "—")}</td><td>${value.active === true ? "Yes" : value.active === false ? "No" : "—"}</td></tr>`).join("")}</tbody>
      </table></div>` : `<div class="muted small lookup-empty">No lookup values found.</div>`}
    </article>`).join("")}</div>
  </section>`;
}

function renderClassesPage({ baseUrl, username, language, classes, lookupTables, domains, labels }) {
  return renderLayout("CMDBuild classes", `
<section class="content-shell">
  <header class="toolbar">
    <div><p class="eyebrow">CMDBuild REST v3 · Node.js</p><h1>Available classes</h1><p class="muted">${escapeHtml(baseUrl)}${username ? ` · ${escapeHtml(username)}` : ""} · ${escapeHtml(language)}</p></div>
    <div class="actions">${renderLanguageSwitcher(language)}<a class="button secondary" href="/classes">Refresh</a><form method="post" action="/logout"><button class="button danger" type="submit">Logout</button></form></div>
  </header>
  <div class="summary">Classes: <strong>${classes.length}</strong>. Visible: <strong id="visible-class-count">${classes.length}</strong>. System attributes are hidden.</div>
  <div class="classes-layout"><div id="classes" class="class-grid">${classes.map((classItem) => renderClassPanel(classItem, labels)).join("")}</div>${renderSidebar(classes, lookupTables, domains)}</div>
  ${renderDomains(domains, labels)}
  ${renderLookups(lookupTables, labels)}
</section>
<script src="/static/classes.js?v=node-20260428"></script>`);
}

async function serveStatic(req, res, pathname) {
  const allowed = new Set(["/static/styles.css", "/static/classes.js"]);
  if (!allowed.has(pathname)) {
    send(res, 404, "Not found");
    return;
  }
  const filePath = path.join(STATIC_DIR, path.basename(pathname));
  const contentType = pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch {
    send(res, 404, "Not found");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const cookies = parseCookies(req);
  const language = normalizeLanguage(cookies.cmdbuild_language);

  try {
    if (req.method === "GET" && url.pathname.startsWith("/static/")) {
      await serveStatic(req, res, url.pathname);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      if (cookies.cmdbuild_token && cookies.cmdbuild_base_url) redirect(res, "/classes");
      else send(res, 200, renderLogin({ cmdbuildUrl: cookies.cmdbuild_base_url || DEFAULT_CMDBUILD_URL }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/login") {
      const form = await readForm(req);
      const baseUrl = normalizeBaseUrl(form.cmdbuild_url || DEFAULT_CMDBUILD_URL);
      const username = String(form.username || "").trim();
      const password = String(form.password || "");
      const loginLanguage = normalizeLanguage(form.language || cookies.cmdbuild_language);
      if (!username || !password) {
        send(res, 200, renderLogin({ error: "Enter username and password.", cmdbuildUrl: baseUrl }));
        return;
      }
      const result = await cmdbuildRequest(baseUrl, "sessions", {
        method: "POST",
        params: { scope: "service", returnId: "true" },
        language: loginLanguage,
        payload: { username, password }
      });
      const token = result?.data?._id;
      if (!token) throw new CmdbuildError("CMDBuild did not return a session token.");
      redirect(res, "/classes", [
        cookieHeader("cmdbuild_token", token),
        cookieHeader("cmdbuild_base_url", baseUrl),
        cookieHeader("cmdbuild_username", username),
        cookieHeader("cmdbuild_language", loginLanguage)
      ]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/classes") {
      if (!cookies.cmdbuild_token || !cookies.cmdbuild_base_url) {
        redirect(res, "/");
        return;
      }
      const loaded = await loadClassesWithAttributes(cookies.cmdbuild_base_url, cookies.cmdbuild_token, language);
      send(res, 200, renderClassesPage({
        baseUrl: cookies.cmdbuild_base_url,
        username: cookies.cmdbuild_username || "",
        language,
        classes: loaded.classes,
        lookupTables: loaded.lookup_tables,
        domains: loaded.domains,
        labels: loaded.labels
      }), {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache"
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/language") {
      const form = await readForm(req);
      const next = String(form.next || "/classes");
      const target = next.startsWith("/") && !next.startsWith("//") ? next : "/classes";
      redirect(res, target, [cookieHeader("cmdbuild_language", normalizeLanguage(form.language))]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/classes") {
      if (!cookies.cmdbuild_token || !cookies.cmdbuild_base_url) {
        sendJson(res, 401, { success: false, message: "not authenticated" });
        return;
      }
      const loaded = await loadClassesWithAttributes(cookies.cmdbuild_base_url, cookies.cmdbuild_token, language);
      sendJson(res, 200, { success: true, language, ...loaded });
      return;
    }
    if (req.method === "POST" && url.pathname === "/logout") {
      redirect(res, "/", [
        clearCookieHeader("cmdbuild_token"),
        clearCookieHeader("cmdbuild_base_url"),
        clearCookieHeader("cmdbuild_username")
      ]);
      return;
    }
    send(res, 404, "Not found");
  } catch (error) {
    if (error instanceof CmdbuildError) {
      if (url.pathname === "/api/classes") {
        sendJson(res, 502, { success: false, message: error.message, details: error.details });
      } else {
        send(res, 502, renderLogin({ error: error.message, cmdbuildUrl: cookies.cmdbuild_base_url || DEFAULT_CMDBUILD_URL }), {
          "Set-Cookie": clearCookieHeader("cmdbuild_token")
        });
      }
      return;
    }
    send(res, 500, renderLogin({ error: error.message || "Internal error", cmdbuildUrl: cookies.cmdbuild_base_url || DEFAULT_CMDBUILD_URL }));
  }
}

createServer((req, res) => {
  handleRequest(req, res);
}).listen(PORT, HOST, () => {
  console.log(`CMDBuild Node.js browser running at http://${HOST}:${PORT}/`);
});
