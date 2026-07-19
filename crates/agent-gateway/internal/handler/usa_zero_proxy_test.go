package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestUSAZeroProxyUsesFixedUpstreamAndRelayAuthorization(t *testing.T) {
	handler := usaZeroProxyWithTransport(time.Second, roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if got, want := req.URL.String(), "http://127.0.0.1:8080/api/v1/keys?page=1"; got != want {
			t.Fatalf("upstream URL = %q, want %q", got, want)
		}
		if got := req.Header.Get("Authorization"); got != "Bearer relay-token" {
			t.Fatalf("relay Authorization = %q", got)
		}
		if got := req.Header.Get(usaZeroAuthHeader); got != "" {
			t.Fatalf("private relay header leaked upstream: %q", got)
		}
		return &http.Response{
			Status:        "200 OK",
			StatusCode:    http.StatusOK,
			Proto:         "HTTP/1.1",
			ProtoMajor:    1,
			ProtoMinor:    1,
			Header:        http.Header{"Content-Type": []string{"application/json"}},
			Body:          io.NopCloser(strings.NewReader(`{"code":0}`)),
			ContentLength: -1,
			Request:       req,
		}, nil
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/usa-zero/keys?page=1", nil)
	req.Header.Set("Authorization", "Bearer gateway-token")
	req.Header.Set(usaZeroAuthHeader, "Bearer relay-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
}

func TestUSAZeroProxyRemovesGatewayAuthorizationForPublicRequests(t *testing.T) {
	proxy := httputilProxyForUSAZeroTest(t, func(req *http.Request) {
		if got := req.Header.Get("Authorization"); got != "" {
			t.Fatalf("Gateway Authorization leaked upstream: %q", got)
		}
	})
	req := httptest.NewRequest(http.MethodGet, "/api/usa-zero/settings/public", nil)
	req.Header.Set("Authorization", "Bearer gateway-token")
	rec := httptest.NewRecorder()
	proxy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
}

func httputilProxyForUSAZeroTest(t *testing.T, assertRequest func(*http.Request)) http.HandlerFunc {
	t.Helper()
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		assertRequest(req)
		return &http.Response{
			Status:        "200 OK",
			StatusCode:    http.StatusOK,
			Proto:         "HTTP/1.1",
			ProtoMajor:    1,
			ProtoMinor:    1,
			Header:        make(http.Header),
			Body:          io.NopCloser(strings.NewReader("{}")),
			ContentLength: -1,
			Request:       req,
		}, nil
	})
	return usaZeroProxyWithTransport(time.Second, transport)
}
