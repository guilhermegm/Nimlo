use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{
    process::{Child, Command},
    sync::watch,
};

const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
const OPEN_COOLDOWN: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    Busy,
    RateLimited,
    Failed,
    TimedOut,
    ShuttingDown,
}

impl OpenError {
    pub fn message(self) -> &'static str {
        match self {
            Self::Busy => "The editor is already opening. Wait a moment and try again.",
            Self::RateLimited => "Wait five seconds before opening the editor again.",
            Self::Failed => {
                "Could not open your default browser. Check your default browser settings or use the private launch link printed by the host."
            }
            Self::TimedOut => {
                "The browser opener did not respond. Check your default browser settings or use the private launch link printed by the host."
            }
            Self::ShuttingDown => {
                "The host is shutting down. Restart the host before opening the editor."
            }
        }
    }
}

#[derive(Default)]
struct OpenState {
    in_flight: bool,
    last_attempt: Option<Instant>,
}

#[derive(Default)]
pub struct Recovery {
    state: Mutex<OpenState>,
}

pub struct OpenPermit<'a> {
    recovery: &'a Recovery,
}

impl Recovery {
    pub fn begin(&self, now: Instant) -> Result<OpenPermit<'_>, OpenError> {
        let mut state = self.state.lock().unwrap();
        if state.in_flight {
            return Err(OpenError::Busy);
        }
        if state
            .last_attempt
            .is_some_and(|last| now.saturating_duration_since(last) < OPEN_COOLDOWN)
        {
            return Err(OpenError::RateLimited);
        }
        state.in_flight = true;
        state.last_attempt = Some(now);
        Ok(OpenPermit { recovery: self })
    }
}

impl Drop for OpenPermit<'_> {
    fn drop(&mut self) {
        self.recovery.state.lock().unwrap().in_flight = false;
    }
}

pub async fn open_private_browser(
    link: String,
    shutdown: watch::Receiver<bool>,
) -> Result<(), OpenError> {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "linux")]
    let opener = "xdg-open";
    #[cfg(target_os = "windows")]
    let opener = "explorer.exe";
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    {
        // The sole argument is a generated loopback launch URL. Suppress child
        // output because the opener could repeat its credential-bearing argument.
        let mut command = Command::new(opener);
        command.arg(link);
        run_opener(command, shutdown, OPEN_TIMEOUT).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        drop((link, shutdown));
        Err(OpenError::Failed)
    }
}

async fn run_opener(
    mut command: Command,
    shutdown: watch::Receiver<bool>,
    timeout: Duration,
) -> Result<(), OpenError> {
    if *shutdown.borrow() {
        return Err(OpenError::ShuttingDown);
    }
    let child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| OpenError::Failed)?;
    wait_opener(child, shutdown, timeout).await
}

async fn wait_opener(
    mut child: Child,
    mut shutdown: watch::Receiver<bool>,
    timeout: Duration,
) -> Result<(), OpenError> {
    let result = if *shutdown.borrow() {
        Err(OpenError::ShuttingDown)
    } else {
        tokio::select! {
            biased;
            _ = shutdown.changed() => Err(OpenError::ShuttingDown),
            result = tokio::time::timeout(timeout, child.wait()) => match result {
                Ok(Ok(status)) if status.success() => Ok(()),
                Ok(_) => Err(OpenError::Failed),
                Err(_) => Err(OpenError::TimedOut),
            },
        }
    };
    if matches!(result, Err(OpenError::ShuttingDown | OpenError::TimedOut)) {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_gate_is_single_flight_rate_limited_and_released_on_drop() {
        let recovery = Recovery::default();
        let now = Instant::now();
        let permit = recovery.begin(now).unwrap();
        assert!(matches!(
            recovery.begin(now + OPEN_COOLDOWN),
            Err(OpenError::Busy)
        ));
        drop(permit);
        assert!(matches!(recovery.begin(now), Err(OpenError::RateLimited)));
        assert!(recovery.begin(now + OPEN_COOLDOWN).is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_openers_report_failures_and_reap_on_timeout_and_shutdown() {
        let (shutdown, _) = watch::channel(false);
        let mut success = Command::new("/bin/sh");
        success.args(["-c", "exit 0"]);
        assert_eq!(
            run_opener(success, shutdown.subscribe(), OPEN_TIMEOUT).await,
            Ok(())
        );
        let mut failure = Command::new("/bin/sh");
        failure.args(["-c", "exit 1"]);
        assert_eq!(
            run_opener(failure, shutdown.subscribe(), OPEN_TIMEOUT).await,
            Err(OpenError::Failed)
        );
        assert_eq!(
            run_opener(
                Command::new("/missing/nimlo-test-opener"),
                shutdown.subscribe(),
                OPEN_TIMEOUT
            )
            .await,
            Err(OpenError::Failed)
        );

        for stop in [false, true] {
            let mut child = Command::new("/bin/sleep");
            child.arg("60").kill_on_drop(true);
            let child = child.spawn().unwrap();
            let pid = child.id().unwrap();
            let changes = shutdown.subscribe();
            if stop {
                shutdown.send_replace(true);
            }
            let result = wait_opener(child, changes, Duration::from_millis(10)).await;
            assert_eq!(
                result,
                Err(if stop {
                    OpenError::ShuttingDown
                } else {
                    OpenError::TimedOut
                })
            );
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
    }
}
