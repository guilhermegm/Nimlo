use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(8 * 60 * 60);

// Fixed-size capability comparisons use subtle's optimization barriers.
pub fn secret_eq(left: &str, right: &str) -> bool {
    if left.len() != 64 || right.len() != 64 {
        return false;
    }
    bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

#[derive(Clone)]
pub struct TokenRecord {
    pub permissions: crate::access::DevicePermissions,
    pub origin: Option<String>,
    pub is_host: bool,
    pub created: Instant,
    pub last_activity: Instant,
}

impl TokenRecord {
    pub fn host(now: Instant) -> Self {
        Self {
            permissions: crate::access::DevicePermissions::FULL,
            origin: None,
            is_host: true,
            created: now,
            last_activity: now,
        }
    }
    pub fn paired(origin: String, now: Instant) -> Self {
        Self {
            permissions: crate::access::DevicePermissions::FULL,
            origin: Some(origin),
            is_host: false,
            created: now,
            last_activity: now,
        }
    }
    pub fn valid(&self, origin: &str, now: Instant) -> bool {
        self.is_host
            || (self.origin.as_deref() == Some(origin)
                && now.saturating_duration_since(self.created) < ABSOLUTE_TIMEOUT
                && now.saturating_duration_since(self.last_activity) < IDLE_TIMEOUT)
    }
    pub fn expired(&self, now: Instant) -> bool {
        !self.is_host
            && (now.saturating_duration_since(self.created) >= ABSOLUTE_TIMEOUT
                || now.saturating_duration_since(self.last_activity) >= IDLE_TIMEOUT)
    }
}

pub fn lookup<'a>(
    records: &'a BTreeMap<String, TokenRecord>,
    token: &str,
) -> Option<(&'a String, &'a TokenRecord)> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut found = None;
    // Never use a tree lookup keyed by the untrusted secret or stop at a match.
    for (candidate, record) in records {
        if secret_eq(candidate, token) {
            found = Some((candidate, record));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_sessions_have_fixed_absolute_and_command_idle_deadlines() {
        let now = Instant::now();
        let mut record = TokenRecord::paired("https://nimlo.example".into(), now);
        assert!(record.valid("https://nimlo.example", now));
        assert!(!record.valid("http://127.0.0.1:7410", now));
        assert!(!record.valid("https://nimlo.example", now + IDLE_TIMEOUT));
        record.last_activity = now + ABSOLUTE_TIMEOUT - Duration::from_secs(1);
        assert!(record.valid("https://nimlo.example", record.last_activity));
        assert!(!record.valid("https://nimlo.example", now + ABSOLUTE_TIMEOUT));
        assert!(!record.expired(now + ABSOLUTE_TIMEOUT - Duration::from_secs(1)));
        assert!(record.expired(now + ABSOLUTE_TIMEOUT));
        assert!(TokenRecord::host(now).valid("http://localhost:7410", now + ABSOLUTE_TIMEOUT));
    }

    #[test]
    fn fixed_secret_comparison_and_bounded_record_lookup_reject_malformed_tokens() {
        let first = "a".repeat(64);
        let last = "f".repeat(64);
        let records = BTreeMap::from([
            (first.clone(), TokenRecord::host(Instant::now())),
            (last.clone(), TokenRecord::host(Instant::now())),
        ]);
        assert!(secret_eq(&first, &first));
        assert!(!secret_eq(&first, &last));
        assert!(lookup(&records, &first).is_some());
        assert!(lookup(&records, &last).is_some());
        for invalid in [
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
            "b".repeat(64),
        ] {
            assert!(lookup(&records, &invalid).is_none());
        }
    }
}
