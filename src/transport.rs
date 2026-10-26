use axum::serve::Listener;
use axum::{Extension, Router, extract::ConnectInfo};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    task::JoinSet,
    time::{Instant, Sleep},
};

pub const MAX_CONNECTIONS: usize = 64;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const READ_IDLE: Duration = Duration::from_secs(60);

pub struct BoundedListener {
    listener: TcpListener,
    permits: Arc<Semaphore>,
}

impl BoundedListener {
    pub fn new(listener: TcpListener) -> Self {
        Self {
            listener,
            permits: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        }
    }
}

pub async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send,
) -> io::Result<()> {
    serve_with_deadline(listener, router, shutdown, HEADER_TIMEOUT).await
}

async fn serve_with_deadline(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send,
    header_timeout: Duration,
) -> io::Result<()> {
    let mut listener = BoundedListener::new(listener);
    let (stop, _) = watch::channel(false);
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            biased;
            _=&mut shutdown => break,
            _=tasks.join_next(), if !tasks.is_empty() => {},
            (stream, address)=listener.accept() => {
                let service=TowerToHyperService::new(router.clone().layer(Extension(ConnectInfo(address))));
                let mut stopped=stop.subscribe();
                tasks.spawn(async move {
                    let mut http=http1::Builder::new();
                    http.timer(TokioTimer::new()).header_read_timeout(header_timeout).max_buf_size(16*1024).max_headers(32);
                    let connection=http.serve_connection(TokioIo::new(stream),service).with_upgrades();
                    tokio::pin!(connection);
                    tokio::select! {
                        _=stopped.changed() => {
                            connection.as_mut().graceful_shutdown();
                            let _=tokio::time::timeout(Duration::from_secs(3),&mut connection).await;
                        },
                        _=&mut connection => {},
                    }
                });
            }
        }
    }
    stop.send_replace(true);
    while tasks.join_next().await.is_some() {}
    Ok(())
}

pub struct Stream {
    stream: TcpStream,
    // Retained through a WebSocket upgrade, not merely its HTTP handshake.
    _permit: OwnedSemaphorePermit,
    deadline: Pin<Box<Sleep>>,
    idle: Duration,
}

impl Listener for BoundedListener {
    type Io = Stream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Stream, SocketAddr) {
        loop {
            let (stream, address) = <TcpListener as Listener>::accept(&mut self.listener).await;
            let Ok(permit) = self.permits.clone().try_acquire_owned() else {
                // Reject excess sockets without allocating a waiting task or
                // parsing their headers. No proxy-controlled IP is trusted.
                drop(stream);
                continue;
            };
            return (
                Stream {
                    stream,
                    _permit: permit,
                    deadline: Box::pin(tokio::time::sleep(READ_IDLE)),
                    idle: READ_IDLE,
                },
                address,
            );
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Connection read timed out",
            )));
        }
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.stream).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) && buffer.filled().len() > before {
            let next = Instant::now() + self.idle;
            self.deadline.as_mut().reset(next);
        }
        result
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn socket_capacity_rejects_excess_and_releases_on_drop() {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = tcp.local_addr().unwrap();
        let mut listener = BoundedListener {
            listener: tcp,
            permits: Arc::new(Semaphore::new(1)),
        };
        let first = TcpStream::connect(address).await.unwrap();
        let (held, _) = listener.accept().await;
        let permits = listener.permits.clone();
        assert_eq!(permits.available_permits(), 0);
        let accept = tokio::spawn(async move { listener.accept().await });
        let mut excess = TcpStream::connect(address).await.unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), excess.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        drop(held);
        drop(first);
        let _next = TcpStream::connect(address).await.unwrap();
        let (next, _) = tokio::time::timeout(Duration::from_secs(1), accept)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(permits.available_permits(), 0);
        drop(next);
        assert_eq!(permits.available_permits(), 1);
    }

    #[tokio::test]
    async fn idle_reads_expire_and_incoming_data_resets_the_deadline() {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut writer = TcpStream::connect(tcp.local_addr().unwrap()).await.unwrap();
        let mut listener = BoundedListener::new(tcp);
        let (mut stream, _) = listener.accept().await;
        stream.idle = Duration::from_millis(120);
        stream.deadline.as_mut().reset(Instant::now() + stream.idle);
        writer.write_all(b"a").await.unwrap();
        let mut byte = [0];
        stream.read_exact(&mut byte).await.unwrap();
        assert_eq!(byte, [b'a']);
        let error = stream.read_exact(&mut byte).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn incomplete_headers_have_an_absolute_deadline_despite_incoming_bytes() {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = tcp.local_addr().unwrap();
        let (stop, mut stopping) = watch::channel(false);
        let router = Router::new().route("/", axum::routing::get(|| async { "ready" }));
        let server = tokio::spawn(serve_with_deadline(
            tcp,
            router,
            async move {
                let _ = stopping.changed().await;
            },
            Duration::from_millis(120),
        ));
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket
            .write_all(format!("GET / HTTP/1.1\r\nHost: {address}\r\nX-Drip: ").as_bytes())
            .await
            .unwrap();
        let (mut reader, mut writer) = socket.into_split();
        let dripping = tokio::spawn(async move {
            for _ in 0..25 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if writer.write_all(b"x").await.is_err() {
                    break;
                }
            }
        });
        let mut response = vec![];
        let closed = tokio::time::timeout(
            Duration::from_millis(400),
            reader.read_to_end(&mut response),
        )
        .await
        .expect("Incomplete headers outlived the absolute deadline");
        // Closing a socket with unread drip bytes may produce TCP reset rather
        // than clean EOF. Both prove closure; other read errors still fail.
        if let Err(error) = closed {
            assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
        }
        assert!(
            response.is_empty(),
            "Incomplete headers produced a response"
        );
        dripping.abort();
        let _ = dripping.await;
        let mut healthy = TcpStream::connect(address).await.unwrap();
        healthy
            .write_all(
                format!("GET / HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        healthy.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        stop.send_replace(true);
        server.await.unwrap().unwrap();
    }
}
