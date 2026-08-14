//! KödMem's fail-closed persistence guard for likely credential material.

use super::{MemoryError, Result};

pub(super) fn validate_optional_no_likely_credential(
    field: &str,
    value: Option<&str>,
) -> Result<()> {
    if let Some(value) = value {
        validate_no_likely_credential(field, value)?;
    }
    Ok(())
}

pub(super) fn validate_no_likely_credential(field: &str, value: &str) -> Result<()> {
    if contains_likely_credential(value) {
        return Err(MemoryError::InvalidInput(format!(
            "{field} contains likely credential material"
        )));
    }
    Ok(())
}

pub(super) fn contains_likely_credential(value: &str) -> bool {
    if serde_json::from_str::<serde_json::Value>(value.trim())
        .is_ok_and(|json| json_contains_likely_credential(&json))
    {
        return true;
    }
    contains_likely_credential_text(value)
}

fn json_contains_likely_credential(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(fields) => fields.iter().any(|(key, value)| {
            let normalized_key = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            let assigned_credential = if normalized_key == "authorization" {
                value
                    .as_str()
                    .is_some_and(contains_authorization_scheme_credential)
            } else if is_suspicious_secret_key(key) {
                json_scalar(value).is_some_and(|assigned| {
                    !assigned.is_empty() && !is_placeholder_value(&assigned)
                })
            } else {
                false
            };
            assigned_credential || json_contains_likely_credential(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(json_contains_likely_credential),
        serde_json::Value::String(value) => contains_likely_credential_text(value),
        _ => false,
    }
}

fn json_scalar(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => Some(value.trim().to_owned()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn contains_likely_credential_text(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    // Split the markers so source-secret scanners do not mistake the detector for a key.
    let private_key_markers = [
        concat!("-----BEGIN ", "PRIVATE KEY-----"),
        concat!("-----BEGIN RSA ", "PRIVATE KEY-----"),
        concat!("-----BEGIN OPENSSH ", "PRIVATE KEY-----"),
        concat!("-----BEGIN EC ", "PRIVATE KEY-----"),
    ];
    if private_key_markers
        .iter()
        .any(|marker| upper.contains(marker))
    {
        return true;
    }
    contains_known_credential_token(value)
        || contains_authorization_credential(value)
        || contains_jwt_bearer(value)
        || contains_uri_userinfo_credential(value)
        || contains_suspicious_assignment(value)
}

// This is deliberately conservative rather than pretending arbitrary prose can
// be classified perfectly. We reject well-known credential forms and values
// assigned to credential-shaped keys, while accepting explicit template values.
fn contains_known_credential_token(value: &str) -> bool {
    const PREFIXES: [(&str, usize); 13] = [
        ("ghp_", 24),
        ("gho_", 24),
        ("ghu_", 24),
        ("ghs_", 24),
        ("ghr_", 24),
        ("github_pat_", 30),
        ("sk-", 23),
        ("xoxb-", 20),
        ("xoxp-", 20),
        ("xoxa-", 20),
        ("xoxr-", 20),
        ("xoxs-", 20),
        ("AKIA", 20),
    ];
    value.char_indices().any(|(start, _)| {
        PREFIXES
            .iter()
            .any(|(prefix, minimum)| credential_token_at(value, start, prefix, *minimum))
            || credential_token_at(value, start, "ASIA", 20)
    })
}

fn contains_jwt_bearer(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(relative_index) = lower[search_from..].find("bearer") {
        let bearer = search_from + relative_index;
        search_from = bearer + "bearer".len();
        if !has_word_boundaries(value, bearer, "bearer".len()) {
            continue;
        }
        let candidate = authorization_value(&value[search_from..]);
        let segments = candidate.split('.').collect::<Vec<_>>();
        if segments.len() == 3
            && segments[0].starts_with("eyJ")
            && segments.iter().all(|segment| {
                segment.len() >= 8
                    && segment
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            })
        {
            return true;
        }
    }
    false
}

// A credential-like Bearer or Basic value is unsafe when it is attached to an
// authorization header. Unlike raw prose about bearer tokens, that shape is a
// concrete request credential even if an OAuth provider makes the value opaque.
fn contains_authorization_credential(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(relative_index) = lower[search_from..].find("authorization") {
        let authorization = search_from + relative_index;
        search_from = authorization + "authorization".len();
        if !has_word_boundaries(value, authorization, "authorization".len()) {
            continue;
        }
        let after_header = trim_serialized_quotes(&value[search_from..]);
        let Some(after_separator) = after_header
            .strip_prefix(':')
            .or_else(|| after_header.strip_prefix('='))
        else {
            continue;
        };
        let credentials = trim_serialized_quotes(after_separator);
        if contains_authorization_scheme_credential(credentials) {
            return true;
        }
    }
    false
}

fn contains_authorization_scheme_credential(value: &str) -> bool {
    let credentials = trim_serialized_quotes(value);
    let lower_credentials = credentials.to_ascii_lowercase();
    for scheme in ["bearer", "basic"] {
        let Some(after_scheme) = lower_credentials.strip_prefix(scheme) else {
            continue;
        };
        if !after_scheme.chars().next().is_some_and(char::is_whitespace) {
            continue;
        }
        let scheme_value = &credentials[scheme.len()..];
        let candidate = authorization_value(scheme_value);
        if !candidate.is_empty()
            && !is_placeholder_value(candidate)
            && !is_authorization_explanatory_prose(scheme_value)
        {
            return true;
        }
    }
    false
}

fn is_authorization_explanatory_prose(value: &str) -> bool {
    let mut words = value.split_whitespace().map(|word| {
        word.trim_matches(|character: char| !character.is_ascii_alphabetic())
            .to_ascii_lowercase()
    });
    let first = words.next().unwrap_or_default();
    let second = words.next().unwrap_or_default();
    matches!(
        (first.as_str(), second.as_str()),
        ("authentication", "is" | "uses" | "means" | "refers")
            | ("authorization", "is" | "uses" | "means" | "refers")
            | ("tokens", "are" | "use")
            | ("credentials", "are" | "use")
            | ("scheme", "is" | "uses")
    )
}

// JSON, JavaScript object literals, and serialized snippets commonly quote both
// the Authorization key and its value. Accept only those narrow wrappers before
// requiring a real header separator, so prose about authorization still passes.
fn trim_serialized_quotes(value: &str) -> &str {
    let mut remaining = value.trim_start_matches(char::is_whitespace);
    loop {
        let next = remaining.strip_prefix(['\'', '\"']).or_else(|| {
            remaining
                .strip_prefix('\\')
                .and_then(|rest| rest.strip_prefix(['\'', '\"']))
        });
        let Some(next) = next else {
            return remaining;
        };
        remaining = next.trim_start_matches(char::is_whitespace);
    }
}

fn has_word_boundaries(value: &str, start: usize, len: usize) -> bool {
    let before = value[..start].chars().next_back();
    let after = value[start + len..].chars().next();
    !before.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && !after.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn authorization_value(value: &str) -> &str {
    value
        .trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == ':')
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches(|ch: char| matches!(ch, '\\' | '\'' | '\"' | ',' | ';' | ')' | ']' | '}'))
}

fn contains_uri_userinfo_credential(value: &str) -> bool {
    let mut remainder = value;
    while let Some(scheme) = remainder.find("://") {
        let authority = &remainder[scheme + 3..]
            .split(['/', '\\', '?', '#', ' ', '\n', '\r'])
            .next()
            .unwrap_or_default();
        if let Some((userinfo, _host)) = authority.rsplit_once('@') {
            if let Some((user, password)) = userinfo.split_once(':') {
                if !user.is_empty() && !password.is_empty() && !is_placeholder_value(password) {
                    return true;
                }
            }
        }
        remainder = &remainder[scheme + 3..];
    }
    false
}

fn contains_suspicious_assignment(value: &str) -> bool {
    for (index, character) in value.char_indices() {
        if character != '=' && character != ':' {
            continue;
        }
        let key = value[..index]
            .rsplit(['\n', '\r', ' ', '\t', ',', ';', '{', '['])
            .next()
            .unwrap_or_default()
            .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-');
        if !is_suspicious_secret_key(key) {
            continue;
        }
        let assigned = value[index + character.len_utf8()..]
            .trim_start()
            .trim_start_matches(['\"', '\''])
            .split(['\n', '\r', ' ', '\t', ',', ';', '&', ')', ']'])
            .next()
            .unwrap_or_default()
            .trim_matches(|ch: char| ch == '\"' || ch == '\'');
        if !assigned.is_empty() && !is_placeholder_value(assigned) {
            return true;
        }
    }
    false
}

fn is_suspicious_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "credential",
        "apikey",
        "accesskey",
        "privatekey",
        "databaseurl",
        "connectionstring",
    ]
    .iter()
    .any(|secret_key| normalized == *secret_key || normalized.ends_with(secret_key))
}

fn is_placeholder_value(value: &str) -> bool {
    let trimmed = value.trim();
    if (trimmed.starts_with("${") && trimmed.ends_with('}'))
        || (trimmed.starts_with("{{") && trimmed.ends_with("}}"))
        || (trimmed.starts_with('<') && trimmed.ends_with('>'))
    {
        return true;
    }
    let normalized = trimmed
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "placeholder"
            | "example"
            | "demo"
            | "redacted"
            | "yourtoken"
            | "yourapikey"
            | "yourpassword"
            | "replacewithtoken"
            | "replacewithvalue"
            | "changeme"
    )
}

fn credential_token_at(value: &str, start: usize, prefix: &str, minimum: usize) -> bool {
    let candidate = &value[start..];
    if !candidate.starts_with(prefix) {
        return false;
    }
    if value[..start]
        .chars()
        .next_back()
        .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return false;
    }
    candidate
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .count()
        >= minimum
}
