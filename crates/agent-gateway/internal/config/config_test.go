package config

import (
	"flag"
	"io"
	"os"
	"testing"
	"time"
)

func TestLoadNormalizesTLSPaths(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TLS_CERT", " cert.pem ")
	t.Setenv("LIVEAGENT_GATEWAY_TLS_KEY", "\tkey.pem\r\n")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.TLSCert != "cert.pem" {
		t.Fatalf("TLSCert = %q, want %q", cfg.TLSCert, "cert.pem")
	}
	if cfg.TLSKey != "key.pem" {
		t.Fatalf("TLSKey = %q, want %q", cfg.TLSKey, "key.pem")
	}
}

func TestLoadWebSocketHeartbeatGrace(t *testing.T) {
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace default = %s, want 5s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("LIVEAGENT_GATEWAY_WS_HEARTBEAT_GRACE", "45s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 45*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace = %s, want 45s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("LIVEAGENT_GATEWAY_WS_HEARTBEAT_GRACE", "-3s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace with negative env = %s, want 5s fallback", cfg.WebSocketHeartbeatGrace)
	}
}

func TestLoadChatTimeouts(t *testing.T) {
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.ChatPrepareTimeout != 2*time.Second {
		t.Fatalf("ChatPrepareTimeout default = %s, want 2s", cfg.ChatPrepareTimeout)
	}
	if cfg.ChatDeliveryTimeout != 5*time.Second {
		t.Fatalf("ChatDeliveryTimeout default = %s, want 5s", cfg.ChatDeliveryTimeout)
	}
	if cfg.ChatStartTimeout != 5*time.Second {
		t.Fatalf("ChatStartTimeout default = %s, want 5s", cfg.ChatStartTimeout)
	}
	if cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("ChatRenderStartTimeout default = %s, want 10s", cfg.ChatRenderStartTimeout)
	}

	t.Setenv("LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", "750ms")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", "3s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT", "4s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", "8s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 750*time.Millisecond ||
		cfg.ChatDeliveryTimeout != 3*time.Second ||
		cfg.ChatStartTimeout != 4*time.Second ||
		cfg.ChatRenderStartTimeout != 8*time.Second {
		t.Fatalf("custom chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}

	t.Setenv("LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", "-1s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", "0s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT", "-1s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", "-1s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 2*time.Second ||
		cfg.ChatDeliveryTimeout != 5*time.Second ||
		cfg.ChatStartTimeout != 5*time.Second ||
		cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("normalized chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}
}

func TestLoadUsesRailwayPortForHTTPDefault(t *testing.T) {
	t.Setenv("PORT", "8080")

	resetFlagsForTest(t)
	cfg := Load()

	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
}

func TestLoadUsesStandaloneDevelopmentDefaults(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("LIVEAGENT_GATEWAY_HTTP_ADDR", "")
	t.Setenv("LIVEAGENT_GATEWAY_COOKIE_SECURE", "")
	t.Setenv("LIVEAGENT_GATEWAY_TLS_CERT", "")
	t.Setenv("LIVEAGENT_GATEWAY_TLS_KEY", "")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.HTTPAddr != ":3001" {
		t.Fatalf("HTTPAddr = %q, want :3001", cfg.HTTPAddr)
	}
	if cfg.CookieSecure {
		t.Fatal("CookieSecure = true, want false for standalone HTTP development")
	}
}

func resetFlagsForTest(t *testing.T) {
	t.Helper()
	oldCommandLine := flag.CommandLine
	oldArgs := os.Args
	t.Cleanup(func() {
		flag.CommandLine = oldCommandLine
		os.Args = oldArgs
	})

	flag.CommandLine = flag.NewFlagSet("gateway", flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	os.Args = []string{"gateway"}
}
