package handler

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	defaultUSAZeroupstreamOrigin = "https://usa0.top"
	usaZeroRoutePrefix           = "/api/usa-zero/"
	usaZeroAPIPathPrefix         = "/api/v1/"
	usaZeroAuthHeader            = "X-USA-Zero-Authorization"
	usaZeroMaxBodyBytes          = 2 << 20
)

// USAZeroProxy exposes only the configured USA-零 API through the authenticated
// Gateway. The upstream is deliberately fixed and cannot be supplied by WebUI.
func USAZeroProxy(timeout time.Duration, upstreamOrigin ...string) http.HandlerFunc {
	origin := defaultUSAZeroupstreamOrigin
	if len(upstreamOrigin) > 0 && strings.TrimSpace(upstreamOrigin[0]) != "" {
		origin = strings.TrimRight(strings.TrimSpace(upstreamOrigin[0]), "/")
	}
	return usaZeroProxyWithOriginAndTransport(timeout, origin, nil)
}

func usaZeroProxyWithTransport(timeout time.Duration, transport http.RoundTripper) http.HandlerFunc {
	return usaZeroProxyWithOriginAndTransport(timeout, defaultUSAZeroupstreamOrigin, transport)
}

func usaZeroProxyWithOriginAndTransport(timeout time.Duration, origin string, transport http.RoundTripper) http.HandlerFunc {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	target, err := url.Parse(origin)
	if err != nil {
		panic(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Director = nil
	if transport == nil {
		transport = &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ForceAttemptHTTP2:     true,
			ResponseHeaderTimeout: timeout,
		}
	}
	proxy.Transport = transport
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		log.Printf("USA-零 proxy request failed: %v", proxyErr)
		status := http.StatusBadGateway
		if errors.Is(proxyErr, http.ErrHandlerTimeout) {
			status = http.StatusGatewayTimeout
		}
		http.Error(w, "USA-零 service is unavailable", status)
	}
	proxy.Rewrite = func(req *httputil.ProxyRequest) {
		req.SetURL(target)
		suffix := strings.TrimPrefix(req.In.URL.Path, usaZeroRoutePrefix)
		cleanSuffix := strings.TrimPrefix(path.Clean("/"+suffix), "/")
		req.Out.URL.Path = usaZeroAPIPathPrefix + cleanSuffix
		req.Out.URL.RawPath = ""

		// Never leak the Gateway bearer token to the local relay.
		req.Out.Header.Del("Authorization")
		if relayAuthorization := strings.TrimSpace(req.In.Header.Get(usaZeroAuthHeader)); relayAuthorization != "" {
			req.Out.Header.Set("Authorization", relayAuthorization)
		}
		req.Out.Header.Del(usaZeroAuthHeader)
		req.Out.Header.Set("X-Forwarded-Host", req.In.Host)
	}

	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, usaZeroRoutePrefix) {
			http.NotFound(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, usaZeroMaxBodyBytes)
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		proxy.ServeHTTP(w, r.WithContext(ctx))
	}
}
