from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from fastapi import Cookie, FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates


DEFAULT_CMDBUILD_URL = "http://127.0.0.1:8090/cmdbuild/services/rest/v3"
REQUEST_TIMEOUT_SECONDS = 20
SYSTEM_ATTRIBUTE_NAMES = {"Id", "IdClass", "IdTenant"}
ANCHOR_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")
JS_LOCALE_ENTRY_RE = re.compile(r"(?<![\w$])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'((?:\\'|[^'])*)'")
DEFAULT_LANGUAGE = "en"
LANGUAGES = [
    {"code": "ar", "description": "العربية"},
    {"code": "bg", "description": "Български"},
    {"code": "cs", "description": "Čeština"},
    {"code": "da", "description": "Dansk"},
    {"code": "de", "description": "Deutsch"},
    {"code": "el_GR", "description": "Ελληνικά"},
    {"code": "en", "description": "English"},
    {"code": "es", "description": "Español"},
    {"code": "fa", "description": "Persian"},
    {"code": "fr", "description": "Français"},
    {"code": "hr", "description": "Hrvatski"},
    {"code": "hu", "description": "Hungarian"},
    {"code": "id", "description": "Bahasa Indonesia"},
    {"code": "it", "description": "Italiano"},
    {"code": "ja", "description": "日本語"},
    {"code": "ko", "description": "한국어"},
    {"code": "mn", "description": "Монгол"},
    {"code": "ms", "description": "Bahasa Melayu"},
    {"code": "nl", "description": "Nederlands"},
    {"code": "no", "description": "Norsk"},
    {"code": "pl", "description": "Polski"},
    {"code": "pt_BR", "description": "Português Brasil"},
    {"code": "pt_PT", "description": "Português Portugal"},
    {"code": "ro", "description": "Română"},
    {"code": "ru", "description": "Русский"},
    {"code": "sk", "description": "Slovenčina"},
    {"code": "sl", "description": "Slovenščina"},
    {"code": "sr", "description": "Srpski"},
    {"code": "sr_RS", "description": "Српски"},
    {"code": "th", "description": "ภาษาไทย"},
    {"code": "tr", "description": "Türkçe"},
    {"code": "ua", "description": "Українська"},
    {"code": "vn", "description": "Tiếng Việt"},
    {"code": "zh_CN", "description": "中文"},
]
LANGUAGE_CODES = {language["code"] for language in LANGUAGES}


app = FastAPI(title="CMDBuild Browser")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@dataclass
class CmdbuildError(Exception):
    message: str
    status_code: int | None = None
    details: Any | None = None


def normalize_base_url(raw_url: str) -> str:
    value = (raw_url or DEFAULT_CMDBUILD_URL).strip().rstrip("/")
    if not value:
        return DEFAULT_CMDBUILD_URL

    if value.endswith("/services/rest/v3"):
        return value
    if value.endswith("/cmdbuild"):
        return f"{value}/services/rest/v3"
    return f"{value}/cmdbuild/services/rest/v3"


def cmdbuild_request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    token: str | None = None,
    language: str | None = None,
    payload: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    if params:
        parts = urlsplit(url)
        query = urlencode(params)
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))

    body = None
    headers = {"Accept": "application/json"}
    if token:
        headers["CMDBuild-Authorization"] = token
    if language:
        headers["Accept-Language"] = language
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = UrlRequest(url, data=body, headers=headers, method=method)

    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raw_error = exc.read().decode("utf-8", errors="replace")
        raise CmdbuildError(
            f"CMDBuild returned HTTP {exc.code}",
            status_code=exc.code,
            details=raw_error,
        ) from exc
    except URLError as exc:
        raise CmdbuildError(f"Could not connect to CMDBuild: {exc.reason}") from exc
    except TimeoutError as exc:
        raise CmdbuildError("CMDBuild did not respond before timeout") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CmdbuildError("CMDBuild returned a non-JSON response", details=raw[:500]) from exc

    if data.get("success") is False:
        message = "CMDBuild rejected the request"
        messages = data.get("messages") or []
        if messages and isinstance(messages, list):
            message = messages[0].get("message") or message
        raise CmdbuildError(message, details=data)

    return data


def normalize_language(raw_language: str | None) -> str:
    language = (raw_language or DEFAULT_LANGUAGE).strip()
    return language if language in LANGUAGE_CODES else DEFAULT_LANGUAGE


def load_translation_map(base_url: str, token: str, language: str) -> dict[str, str]:
    if not language:
        return {}

    try:
        result = cmdbuild_request(
            base_url,
            "translations",
            token=token,
            language=language,
            params={"scope": "service", "limit": 100000},
        )
    except CmdbuildError:
        return {}
    translations: dict[str, str] = {}
    for item in result.get("data", []):
        if item.get("lang") == language and item.get("code") and item.get("value"):
            translations[item["code"]] = item["value"]
    return translations


def ui_base_url_from_rest(base_url: str) -> str:
    value = base_url.rstrip("/")
    suffix = "/services/rest/v3"
    if value.endswith(suffix):
        return value[: -len(suffix)]
    return value


def parse_js_locale_labels(raw_locale: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    for key, value in JS_LOCALE_ENTRY_RE.findall(raw_locale):
        normalized_key = key.casefold()
        if normalized_key not in labels:
            labels[normalized_key] = value.replace("\\'", "'")
    return labels


def load_ui_locale_labels(base_url: str, language: str) -> dict[str, str]:
    if not language or language == DEFAULT_LANGUAGE:
        return {}

    ui_base_url = ui_base_url_from_rest(base_url)
    labels: dict[str, str] = {}
    for path in (
        f"ui/app/locales/{quote(language, safe='')}/Locales.js",
        f"ui/app/locales/{quote(language, safe='')}/LocalesAdministration.js",
    ):
        url = f"{ui_base_url}/{path}"
        try:
            with urlopen(url, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                raw_locale = response.read().decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError):
            continue
        for key, value in parse_js_locale_labels(raw_locale).items():
            labels.setdefault(key, value)
    return labels


def template_labels(ui_labels: dict[str, str]) -> dict[str, str]:
    return {
        "active": ui_labels.get("active") or "Active",
        "attributes": ui_labels.get("attributes") or "Attributes",
        "cardinality": ui_labels.get("cardinality") or "Cardinality",
        "code": ui_labels.get("code") or "Code",
        "description": ui_labels.get("description") or "Description",
        "destination": ui_labels.get("destination") or "Destination",
        "direct": ui_labels.get("direct") or "Direct",
        "domain": ui_labels.get("domain") or "Domain",
        "help_text": ui_labels.get("helptext") or ui_labels.get("help") or "Help text",
        "inverse": ui_labels.get("inverse") or "Inverse",
        "name": ui_labels.get("name") or "Name",
        "note": ui_labels.get("note") or "Note",
        "origin": ui_labels.get("origin") or ui_labels.get("source") or "Origin",
        "type": ui_labels.get("type") or "Type",
        "value": ui_labels.get("value") or "Value",
    }


def translated_value(translations: dict[str, str], *codes: str) -> str:
    for code in codes:
        if code and translations.get(code):
            return translations[code]
    return ""


def translated_description(
    item: dict[str, Any],
    translations: dict[str, str],
    *codes: str,
    fallback_name: str = "",
) -> str:
    return (
        translated_value(translations, *codes)
        or item.get("_description_translation")
        or item.get("description")
        or fallback_name
    )


def localized_field_label(
    raw_name: str,
    metadata_description: str,
    ui_labels: dict[str, str],
) -> str:
    normalized_name = raw_name.casefold()
    normalized_description = metadata_description.casefold()
    if metadata_description and normalized_description != normalized_name:
        return ui_labels.get(normalized_description) or metadata_description
    return ui_labels.get(normalized_name) or metadata_description or raw_name


def is_system_attribute(attribute: dict[str, Any]) -> bool:
    name = attribute.get("name")
    mode = attribute.get("mode")
    return name in SYSTEM_ATTRIBUTE_NAMES or mode == "syshidden" or mode == "sysreadonly"


def make_anchor(prefix: str, value: str) -> str:
    slug = ANCHOR_SAFE_RE.sub("-", value.strip()).strip("-")
    return f"{prefix}-{slug or 'item'}"


def normalize_attribute(
    attribute: dict[str, Any],
    translations: dict[str, str] | None = None,
    ui_labels: dict[str, str] | None = None,
    *,
    owner_name: str = "",
) -> dict[str, Any]:
    translations = translations or {}
    ui_labels = ui_labels or {}
    lookup_type = attribute.get("lookupType") or ""
    name = attribute.get("name") or ""
    metadata_description = translated_description(
        attribute,
        translations,
        f"attribute.{owner_name}.{name}.description",
        f"class.{owner_name}.attribute.{name}.description",
        f"domain.{owner_name}.attribute.{name}.description",
        fallback_name=name,
    )
    display_name = localized_field_label(name, metadata_description, ui_labels)

    return {
        "name": name,
        "display_name": display_name,
        "type": attribute.get("type") or "",
        "description": display_name,
        "help_text": attribute.get("help") or "",
        "inherited": bool(attribute.get("inherited")),
        "lookup_type": lookup_type,
        "lookup_anchor": make_anchor("lookup", lookup_type) if lookup_type else "",
    }


def load_class_attributes(
    base_url: str,
    token: str,
    class_name: str,
    translations: dict[str, str],
    ui_labels: dict[str, str],
    language: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    result = cmdbuild_request(
        base_url,
        f"classes/{class_name}/attributes",
        token=token,
        language=language,
        params={"scope": "service", "limit": 500},
    )

    own_attributes: list[dict[str, Any]] = []
    inherited_attributes: list[dict[str, Any]] = []

    for raw_attribute in result.get("data", []):
        if is_system_attribute(raw_attribute):
            continue

        attribute = normalize_attribute(raw_attribute, translations, ui_labels, owner_name=class_name)
        if attribute["inherited"]:
            inherited_attributes.append(attribute)
        else:
            own_attributes.append(attribute)

    return own_attributes, inherited_attributes


def register_lookup_usage(
    lookup_index: dict[str, dict[str, Any]],
    class_item: dict[str, Any],
    attribute: dict[str, Any],
) -> None:
    lookup_type = attribute.get("lookup_type")
    class_name = class_item.get("name")
    if not lookup_type or not class_name:
        return

    lookup = lookup_index.setdefault(
        lookup_type,
        {
            "name": lookup_type,
            "anchor": make_anchor("lookup", lookup_type),
            "usages_by_class": {},
        },
    )
    usages_by_class = lookup["usages_by_class"]
    usage = usages_by_class.setdefault(
        class_name,
        {
            "class_name": class_name,
            "class_display_name": class_item.get("display_name") or class_name,
            "class_anchor": class_item.get("anchor") or make_anchor("class", class_name),
            "attributes": [],
        },
    )
    usage["attributes"].append(
        {
            "name": attribute.get("name") or "",
            "display_name": attribute.get("display_name") or attribute.get("name") or "",
            "inherited": bool(attribute.get("inherited")),
        }
    )


def lookup_value_key(value: dict[str, Any]) -> tuple[str, str]:
    return (str(value.get("description") or "").casefold(), str(value.get("code") or "").casefold())


def lookup_value_id(value: dict[str, Any]) -> str:
    raw_id = value.get("_id")
    if raw_id is None:
        raw_id = value.get("id") or value.get("code")
    return str(raw_id)


def lookup_parent_id(value: dict[str, Any]) -> str | None:
    parent = value.get("parent")
    if isinstance(parent, dict):
        parent = parent.get("_id") or parent.get("id")
    if parent is None:
        parent = value.get("parent_id")
    return str(parent) if parent is not None else None


def build_lookup_hierarchy(
    raw_values: list[dict[str, Any]],
    lookup_name: str,
    translations: dict[str, str],
) -> tuple[list[dict[str, Any]], bool]:
    values: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    children_by_parent: dict[str | None, list[dict[str, Any]]] = {}

    for raw_value in raw_values:
        value_id = lookup_value_id(raw_value)
        code = raw_value.get("code") or ""
        description = translated_description(
            raw_value,
            translations,
            f"lookup.{lookup_name}.{code}.description",
            fallback_name=code or value_id,
        )
        value = {
            "id": value_id,
            "code": code,
            "description": description,
            "parent_id": lookup_parent_id(raw_value),
            "note": raw_value.get("note") or "",
            "active": raw_value.get("active"),
            "index": raw_value.get("index"),
            "level": 0,
            "has_children": False,
        }
        values.append(value)
        by_id[value_id] = value

    for value in values:
        parent_id = value["parent_id"]
        if parent_id not in by_id:
            parent_id = None
        children_by_parent.setdefault(parent_id, []).append(value)

    for children in children_by_parent.values():
        children.sort(key=lookup_value_key)

    ordered: list[dict[str, Any]] = []
    visited: set[str] = set()

    def visit(value: dict[str, Any], level: int) -> None:
        value_id = value["id"]
        if value_id in visited:
            return
        visited.add(value_id)
        value["level"] = level
        value_children = children_by_parent.get(value_id, [])
        value["has_children"] = bool(value_children)
        ordered.append(value)

        for child in value_children:
            visit(child, level + 1)

    for root in children_by_parent.get(None, []):
        visit(root, 0)

    for value in sorted(values, key=lookup_value_key):
        if value["id"] not in visited:
            visit(value, 0)

    is_hierarchical = any(value["level"] > 0 or value["has_children"] for value in ordered)
    return ordered, is_hierarchical


def lookup_sort_label(lookup: dict[str, Any]) -> str:
    return (lookup.get("description") or lookup.get("name") or "").casefold()


def sort_lookup_names_by_parent(lookup_index: dict[str, dict[str, Any]]) -> list[str]:
    children_by_parent: dict[str | None, list[str]] = {}

    for lookup_name, lookup in lookup_index.items():
        parent = lookup.get("parent")
        if parent not in lookup_index:
            parent = None
        children_by_parent.setdefault(parent, []).append(lookup_name)

    for children in children_by_parent.values():
        children.sort(key=lambda name: lookup_sort_label(lookup_index[name]))

    for lookup_name, lookup in lookup_index.items():
        lookup["has_children"] = bool(children_by_parent.get(lookup_name))

    ordered: list[str] = []
    visited: set[str] = set()

    def visit(lookup_name: str, level: int) -> None:
        if lookup_name in visited:
            return
        visited.add(lookup_name)
        lookup_index[lookup_name]["hierarchy_level"] = level
        ordered.append(lookup_name)

        for child_name in children_by_parent.get(lookup_name, []):
            visit(child_name, level + 1)

    for root_name in children_by_parent.get(None, []):
        visit(root_name, 0)

    for lookup_name in sorted(lookup_index, key=lambda name: lookup_sort_label(lookup_index[name])):
        if lookup_name not in visited:
            visit(lookup_name, 0)

    return ordered


def load_domains(
    base_url: str,
    token: str,
    class_anchors: dict[str, str],
    class_labels: dict[str, str],
    translations: dict[str, str],
    ui_labels: dict[str, str],
    language: str,
) -> list[dict[str, Any]]:
    result = cmdbuild_request(
        base_url,
        "domains",
        token=token,
        language=language,
        params={"scope": "service", "limit": 1000},
    )

    domains: list[dict[str, Any]] = []
    for raw_domain in sorted(result.get("data", []), key=lambda item: (item.get("description") or item.get("name") or "").casefold()):
        domain_name = raw_domain.get("name") or raw_domain.get("_id")
        if not domain_name:
            continue

        domain = raw_domain
        try:
            detail = cmdbuild_request(
                base_url,
                f"domains/{quote(domain_name, safe='')}",
                token=token,
                language=language,
                params={"scope": "service"},
            )
            domain = detail.get("data") or raw_domain
        except CmdbuildError:
            domain = raw_domain

        source = domain.get("source") or ""
        destination = domain.get("destination") or ""
        sources = domain.get("sources") or ([source] if source else [])
        destinations = domain.get("destinations") or ([destination] if destination else [])
        source_links = [
            {"name": class_name, "display_name": class_labels.get(class_name, class_name), "anchor": class_anchors.get(class_name, "")}
            for class_name in sources
            if class_name
        ]
        destination_links = [
            {"name": class_name, "display_name": class_labels.get(class_name, class_name), "anchor": class_anchors.get(class_name, "")}
            for class_name in destinations
            if class_name
        ]
        attributes: list[dict[str, Any]] = []
        attributes_error = None
        try:
            attributes_result = cmdbuild_request(
                base_url,
                f"domains/{quote(domain_name, safe='')}/attributes",
                token=token,
                language=language,
                params={"scope": "service", "limit": 1000},
            )
            attributes = [
                normalize_attribute(raw_attribute, translations, ui_labels, owner_name=domain_name)
                for raw_attribute in attributes_result.get("data", [])
                if not is_system_attribute(raw_attribute)
            ]
        except CmdbuildError as exc:
            attributes_error = exc.message

        description = translated_description(
            domain,
            translations,
            f"domain.{domain_name}.description",
            fallback_name=domain_name,
        )
        description_direct = (
            translated_value(
                translations,
                f"domain.{domain_name}.descriptionDirect",
                f"domain.{domain_name}.direct",
            )
            or domain.get("_descriptionDirect_translation")
            or domain.get("descriptionDirect")
            or ""
        )
        description_inverse = (
            translated_value(
                translations,
                f"domain.{domain_name}.descriptionInverse",
                f"domain.{domain_name}.inverse",
            )
            or domain.get("_descriptionInverse_translation")
            or domain.get("descriptionInverse")
            or ""
        )
        domains.append(
            {
                "name": domain_name,
                "display_name": description,
                "anchor": make_anchor("domain", domain_name),
                "attributes_anchor": f"{make_anchor('domain', domain_name)}-attributes",
                "description": description,
                "source": source,
                "source_anchor": class_anchors.get(source, ""),
                "source_links": source_links,
                "source_names": sources,
                "destination": destination,
                "destination_anchor": class_anchors.get(destination, ""),
                "destination_links": destination_links,
                "destination_names": destinations,
                "cardinality": domain.get("cardinality") or "",
                "description_direct": description_direct,
                "description_inverse": description_inverse,
                "is_master_detail": bool(domain.get("isMasterDetail")),
                "active": domain.get("active"),
                "attributes": attributes,
                "attributes_error": attributes_error,
            }
        )

    return domains


def attach_domains_to_classes(classes: list[dict[str, Any]], domains: list[dict[str, Any]]) -> None:
    classes_by_name = {
        class_item.get("name"): class_item
        for class_item in classes
        if class_item.get("name")
    }

    for class_item in classes:
        class_item["related_domains"] = []

    for domain in domains:
        related_names = set(domain.get("source_names", [])) | set(domain.get("destination_names", []))
        related_names &= set(classes_by_name)
        for class_name in related_names:
            classes_by_name[class_name]["related_domains"].append(
                {
                    "name": domain["name"],
                    "display_name": domain.get("display_name") or domain["name"],
                    "anchor": domain["anchor"],
                    "description": domain.get("description") or "",
                    "source_links": domain.get("source_links", []),
                    "destination_links": domain.get("destination_links", []),
                    "cardinality": domain.get("cardinality") or "",
                    "attributes_anchor": domain["attributes_anchor"],
                    "attributes_count": len(domain.get("attributes", [])),
                }
            )


def load_lookup_tables(
    base_url: str,
    token: str,
    lookup_index: dict[str, dict[str, Any]],
    translations: dict[str, str],
    language: str,
) -> list[dict[str, Any]]:
    lookup_tables: list[dict[str, Any]] = []
    result = cmdbuild_request(
        base_url,
        "lookup_types",
        token=token,
        language=language,
        params={"scope": "service", "limit": 1000},
    )

    for raw_lookup in result.get("data", []):
        lookup_name = raw_lookup.get("name") or raw_lookup.get("_id")
        if not lookup_name:
            continue

        lookup = lookup_index.setdefault(
            lookup_name,
            {
                "name": lookup_name,
                "anchor": make_anchor("lookup", lookup_name),
                "usages_by_class": {},
            },
        )
        lookup["description"] = raw_lookup.get("description") or ""
        lookup["parent"] = raw_lookup.get("parent") or None
        lookup["speciality"] = raw_lookup.get("speciality") or ""
        lookup["access_type"] = raw_lookup.get("accessType") or ""

    for lookup_name in sort_lookup_names_by_parent(lookup_index):
        lookup = lookup_index[lookup_name]
        parent = lookup.get("parent")
        usages = sorted(
            lookup["usages_by_class"].values(),
            key=lambda usage: usage["class_name"].casefold(),
        )
        table = {
            "name": lookup_name,
            "display_name": translated_value(translations, f"lookup.{lookup_name}.description") or lookup.get("description") or lookup_name,
            "description": translated_value(translations, f"lookup.{lookup_name}.description") or lookup.get("description") or "",
            "parent": parent if parent in lookup_index else "",
            "parent_anchor": make_anchor("lookup", parent) if parent in lookup_index else "",
            "parent_display_name": (
                translated_value(translations, f"lookup.{parent}.description")
                or lookup_index.get(parent, {}).get("description")
                or parent
                or ""
            ) if parent in lookup_index else "",
            "hierarchy_level": lookup.get("hierarchy_level", 0),
            "has_children": bool(lookup.get("has_children")),
            "speciality": lookup.get("speciality") or "",
            "access_type": lookup.get("access_type") or "",
            "anchor": lookup["anchor"],
            "usages": usages,
            "values": [],
            "is_hierarchical": False,
            "values_error": None,
        }

        try:
            result = cmdbuild_request(
                base_url,
                f"lookup_types/{quote(lookup_name, safe='')}/values",
                token=token,
                language=language,
                params={"scope": "service", "limit": 1000},
            )
            table["values"], table["is_hierarchical"] = build_lookup_hierarchy(result.get("data", []), lookup_name, translations)
        except CmdbuildError as exc:
            table["values_error"] = exc.message

        lookup_tables.append(table)

    return lookup_tables


def load_classes_with_attributes(
    base_url: str,
    token: str,
    language: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    translations = load_translation_map(base_url, token, language)
    ui_labels = load_ui_locale_labels(base_url, language)
    result = cmdbuild_request(
        base_url,
        "classes",
        token=token,
        language=language,
        params={"scope": "service", "limit": 500},
    )

    classes = sort_classes_by_inheritance(result.get("data", []))
    class_anchors = {
        class_item.get("name"): make_anchor("class", class_item.get("name") or "")
        for class_item in classes
        if class_item.get("name")
    }
    class_labels: dict[str, str] = {}
    lookup_index: dict[str, dict[str, Any]] = {}

    for class_item in classes:
        class_name = class_item.get("name")
        class_item["anchor"] = class_anchors.get(class_name, make_anchor("class", class_name or ""))
        class_item["parent_anchor"] = class_anchors.get(class_item.get("parent"), "")
        class_item["display_name"] = translated_description(
            class_item,
            translations,
            f"class.{class_name}.description" if class_name else "",
            fallback_name=class_name or "",
        )
        class_labels[class_name] = class_item["display_name"]
        class_item["own_attributes"] = []
        class_item["inherited_attributes"] = []
        class_item["display_attributes"] = []
        class_item["attributes_error"] = None
        class_item["is_superclass"] = bool(class_item.get("prototype"))

        if not class_name:
            class_item["attributes_error"] = "Class has no name."
            continue

        try:
            own_attributes, inherited_attributes = load_class_attributes(base_url, token, class_name, translations, ui_labels, language)
            class_item["own_attributes"] = own_attributes
            class_item["inherited_attributes"] = inherited_attributes
            class_item["display_attributes"] = own_attributes
            for attribute in inherited_attributes + own_attributes:
                register_lookup_usage(lookup_index, class_item, attribute)
        except CmdbuildError as exc:
            class_item["attributes_error"] = exc.message

    for class_item in classes:
        parent = class_item.get("parent")
        class_item["parent_display_name"] = class_labels.get(parent, parent or "")

    lookup_tables = load_lookup_tables(base_url, token, lookup_index, translations, language)
    domains = load_domains(base_url, token, class_anchors, class_labels, translations, ui_labels, language)
    attach_domains_to_classes(classes, domains)
    return classes, lookup_tables, domains, template_labels(ui_labels)


def class_sort_label(class_item: dict[str, Any]) -> str:
    return (class_item.get("description") or class_item.get("name") or "").casefold()


def sort_classes_by_inheritance(classes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_name = {class_item.get("name"): class_item for class_item in classes if class_item.get("name")}
    children_by_parent: dict[str | None, list[dict[str, Any]]] = {}

    for class_item in classes:
        parent = class_item.get("parent")
        if parent not in by_name:
            parent = None
        children_by_parent.setdefault(parent, []).append(class_item)

    for siblings in children_by_parent.values():
        siblings.sort(key=class_sort_label)

    for class_item in classes:
        class_name = class_item.get("name")
        class_item["has_children"] = bool(class_name and children_by_parent.get(class_name))

    ordered: list[dict[str, Any]] = []
    visited: set[str] = set()

    def visit(class_item: dict[str, Any]) -> None:
        class_name = class_item.get("name")
        if class_name and class_name in visited:
            return
        if class_name:
            visited.add(class_name)

        class_item["hierarchy_level"] = get_hierarchy_level(class_item, by_name)
        ordered.append(class_item)

        for child in children_by_parent.get(class_name, []):
            visit(child)

    for root in children_by_parent.get(None, []):
        visit(root)

    for class_item in sorted(classes, key=class_sort_label):
        class_name = class_item.get("name")
        if not class_name or class_name not in visited:
            visit(class_item)

    return ordered


def get_hierarchy_level(class_item: dict[str, Any], by_name: dict[str, dict[str, Any]]) -> int:
    level = 0
    seen: set[str] = set()
    parent = class_item.get("parent")

    while parent in by_name and parent not in seen:
        seen.add(parent)
        level += 1
        parent = by_name[parent].get("parent")

    return level


async def read_form(request: Request) -> dict[str, str]:
    body = await request.body()
    parsed = parse_qs(body.decode("utf-8"), keep_blank_values=True)
    return {key: values[0] if values else "" for key, values in parsed.items()}


def login_response(
    request: Request,
    *,
    error: str | None = None,
    cmdbuild_url: str = DEFAULT_CMDBUILD_URL,
    language: str = DEFAULT_LANGUAGE,
) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "login.html",
        {
            "request": request,
            "error": error,
            "cmdbuild_url": cmdbuild_url,
            "language": normalize_language(language),
            "languages": LANGUAGES,
        },
    )


@app.get("/", response_class=HTMLResponse)
async def index(
    request: Request,
    cmdbuild_token: str | None = Cookie(default=None),
    cmdbuild_base_url: str | None = Cookie(default=None),
    cmdbuild_language: str | None = Cookie(default=None),
):
    if cmdbuild_token and cmdbuild_base_url:
        return RedirectResponse("/classes", status_code=303)
    return login_response(request, language=normalize_language(cmdbuild_language))


@app.post("/login")
async def login(request: Request):
    form = await read_form(request)
    base_url = normalize_base_url(form.get("cmdbuild_url", DEFAULT_CMDBUILD_URL))
    username = form.get("username", "").strip()
    password = form.get("password", "")
    language = normalize_language(form.get("language"))

    if not username or not password:
        return login_response(
            request,
            error="Enter username and password.",
            cmdbuild_url=base_url,
            language=language,
        )

    try:
        result = cmdbuild_request(
            base_url,
            "sessions",
            method="POST",
            params={"scope": "service", "returnId": "true"},
            language=language,
            payload={"username": username, "password": password},
        )
        token = result["data"]["_id"]
    except (KeyError, CmdbuildError) as exc:
        message = exc.message if isinstance(exc, CmdbuildError) else "CMDBuild did not return a session token."
        return login_response(request, error=message, cmdbuild_url=base_url, language=language)

    response = RedirectResponse("/classes", status_code=303)
    response.set_cookie("cmdbuild_token", token, httponly=True, samesite="lax")
    response.set_cookie("cmdbuild_base_url", base_url, httponly=True, samesite="lax")
    response.set_cookie("cmdbuild_username", username, httponly=True, samesite="lax")
    response.set_cookie("cmdbuild_language", language, httponly=True, samesite="lax")
    return response


@app.get("/classes", response_class=HTMLResponse)
async def classes_page(
    request: Request,
    cmdbuild_token: str | None = Cookie(default=None),
    cmdbuild_base_url: str | None = Cookie(default=None),
    cmdbuild_username: str | None = Cookie(default=None),
    cmdbuild_language: str | None = Cookie(default=None),
):
    if not cmdbuild_token or not cmdbuild_base_url:
        return RedirectResponse("/", status_code=303)

    language = normalize_language(cmdbuild_language)
    try:
        classes, lookup_tables, domains, labels = load_classes_with_attributes(cmdbuild_base_url, cmdbuild_token, language)
    except CmdbuildError as exc:
        response = login_response(request, error=exc.message, cmdbuild_url=cmdbuild_base_url, language=language)
        response.delete_cookie("cmdbuild_token")
        return response

    response = templates.TemplateResponse(
        request,
        "classes.html",
        {
            "request": request,
            "base_url": cmdbuild_base_url,
            "username": cmdbuild_username or "",
            "language": language,
            "classes": classes,
            "lookup_tables": lookup_tables,
            "domains": domains,
            "labels": labels,
            "total": len(classes),
        },
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


@app.get("/api/classes")
async def classes_api(
    cmdbuild_token: str | None = Cookie(default=None),
    cmdbuild_base_url: str | None = Cookie(default=None),
    cmdbuild_language: str | None = Cookie(default=None),
):
    if not cmdbuild_token or not cmdbuild_base_url:
        return JSONResponse({"success": False, "message": "not authenticated"}, status_code=401)

    language = normalize_language(cmdbuild_language)
    try:
        classes, lookup_tables, domains, labels = load_classes_with_attributes(cmdbuild_base_url, cmdbuild_token, language)
    except CmdbuildError as exc:
        return JSONResponse(
            {"success": False, "message": exc.message, "details": exc.details},
            status_code=502,
        )

    return JSONResponse(
        {
            "success": True,
            "language": language,
            "labels": labels,
            "classes": classes,
            "lookup_tables": lookup_tables,
            "domains": domains,
        }
    )


@app.post("/logout")
async def logout():
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie("cmdbuild_token")
    response.delete_cookie("cmdbuild_base_url")
    response.delete_cookie("cmdbuild_username")
    response.delete_cookie("cmdbuild_language")
    return response


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
