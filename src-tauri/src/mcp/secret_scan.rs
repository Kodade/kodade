use std::sync::LazyLock;

use regex::RegexSet;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretKind {
    PrivateKey,
    AwsAccessKey,
    GithubToken,
    SlackToken,
    AssignedSecret,
}

impl SecretKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PrivateKey => "private_key",
            Self::AwsAccessKey => "aws_access_key",
            Self::GithubToken => "github_token",
            Self::SlackToken => "slack_token",
            Self::AssignedSecret => "assigned_secret",
        }
    }
}

pub fn detect(value: &str) -> Option<SecretKind> {
    static PATTERNS: LazyLock<RegexSet> = LazyLock::new(|| {
        RegexSet::new([
            r"-----begin[^\r\n]*private key(?:-----)?",
            r"akia[0-9a-z]{16}",
            r"gh[pousr]_[a-z0-9]{36,}",
            r"xox[baprs]-",
            r"(api[_-]?key|secret|token|password)\s*[:=]\s*\S{12,}",
        ])
        .expect("KödMCP secret patterns are valid")
    });
    let detection_copy: String = value.nfkc().flat_map(char::to_lowercase).collect();

    PATTERNS
        .matches(&detection_copy)
        .iter()
        .next()
        .map(|index| match index {
            0 => SecretKind::PrivateKey,
            1 => SecretKind::AwsAccessKey,
            2 => SecretKind::GithubToken,
            3 => SecretKind::SlackToken,
            4 => SecretKind::AssignedSecret,
            _ => unreachable!("RegexSet only returns configured pattern indexes"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_each_rejected_secret_pattern() {
        let cases = [
            (
                format!(
                    "-----BEGIN {} PRIVATE KEY-----\nencoded\n-----END {} PRIVATE KEY-----",
                    "OPENSSH", "OPENSSH"
                ),
                SecretKind::PrivateKey,
            ),
            (
                format!("{}{}", "AKIA", "0123456789ABCDEF"),
                SecretKind::AwsAccessKey,
            ),
            (
                format!("{}{}", "ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
                SecretKind::GithubToken,
            ),
            (
                format!("{}{}", "xoxb-", "not-a-real-token"),
                SecretKind::SlackToken,
            ),
            (
                format!("api_key = {}", "abcdefghijklmnop"),
                SecretKind::AssignedSecret,
            ),
        ];

        for (value, expected) in cases {
            assert_eq!(detect(&value), Some(expected), "missed {expected:?}");
        }
    }

    #[test]
    fn allows_clean_project_memory() {
        assert_eq!(
            detect("Use the MCP adapter for local project context."),
            None
        );
    }

    #[test]
    fn detects_nfkc_equivalent_fullwidth_secret_assignment() {
        assert_eq!(
            detect("ＡＰＩ＿ＫＥＹ＝abcdefghijklmnop"),
            Some(SecretKind::AssignedSecret)
        );
    }
}
