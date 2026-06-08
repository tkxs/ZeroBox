package server

import (
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

const tunnelRewriteBodyMaxBytes = 4 * 1024 * 1024

type tunnelResponseRewriteKind int

const (
	tunnelResponseRewriteNone tunnelResponseRewriteKind = iota
	tunnelResponseRewriteHTML
	tunnelResponseRewriteCSS
	tunnelResponseRewriteJavaScript
)

var (
	tunnelHTMLQuotedAttrURLPattern = regexp.MustCompile(`(?i)(\b(?:href|src|action|poster|data|formaction)\s*=\s*)(["'])([^"']+)(["'])`)
	tunnelHTMLBareAttrURLPattern   = regexp.MustCompile(`(?i)(\b(?:href|src|action|poster|data|formaction)\s*=\s*)([^\s"'<>]+)`)
	tunnelJSQuotedURLPattern       = regexp.MustCompile(`(["'])(/[^"'\\]*)(["'])`)
	tunnelCSSURLPattern            = regexp.MustCompile(`(?i)(url\(\s*)(["']?)([^"')]+)(["']?\s*\))`)
)

func tunnelResponseRewriteKindFor(
	method string,
	status int,
	headers http.Header,
) tunnelResponseRewriteKind {
	if strings.EqualFold(strings.TrimSpace(method), http.MethodHead) {
		return tunnelResponseRewriteNone
	}
	if status < http.StatusOK ||
		status == http.StatusNoContent ||
		status == http.StatusNotModified {
		return tunnelResponseRewriteNone
	}
	if strings.TrimSpace(headers.Get("Content-Encoding")) != "" {
		return tunnelResponseRewriteNone
	}

	contentType := strings.TrimSpace(headers.Get("Content-Type"))
	if contentType == "" {
		return tunnelResponseRewriteNone
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = contentType
	}
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))

	switch {
	case mediaType == "text/html" || mediaType == "application/xhtml+xml":
		return tunnelResponseRewriteHTML
	case mediaType == "text/css":
		return tunnelResponseRewriteCSS
	case mediaType == "text/javascript",
		mediaType == "application/javascript",
		mediaType == "application/x-javascript",
		mediaType == "text/ecmascript",
		mediaType == "application/ecmascript",
		strings.HasSuffix(mediaType, "+javascript"):
		return tunnelResponseRewriteJavaScript
	default:
		return tunnelResponseRewriteNone
	}
}

func rewriteTunnelResponseBody(
	body []byte,
	tunnel *gatewayv1.TunnelSummary,
	kind tunnelResponseRewriteKind,
) ([]byte, bool) {
	if len(body) == 0 || kind == tunnelResponseRewriteNone || tunnelPublicPathPrefix(tunnel) == "" {
		return body, false
	}
	if !utf8.Valid(body) {
		return body, false
	}

	original := string(body)
	rewritten := original
	switch kind {
	case tunnelResponseRewriteHTML:
		rewritten = rewriteTunnelHTMLBody(rewritten, tunnel)
	case tunnelResponseRewriteCSS:
		rewritten = rewriteTunnelCSSBody(rewritten, tunnel)
	case tunnelResponseRewriteJavaScript:
		rewritten = rewriteTunnelJavaScriptBody(rewritten, tunnel)
	}
	if rewritten == original {
		return body, false
	}
	return []byte(rewritten), true
}

func rewriteTunnelHTMLBody(input string, tunnel *gatewayv1.TunnelSummary) string {
	input = tunnelHTMLQuotedAttrURLPattern.ReplaceAllStringFunc(input, func(match string) string {
		parts := tunnelHTMLQuotedAttrURLPattern.FindStringSubmatch(match)
		if len(parts) != 5 {
			return match
		}
		rewritten := rewriteTunnelBodyURL(parts[3], tunnel)
		if rewritten == parts[3] {
			return match
		}
		return parts[1] + parts[2] + rewritten + parts[4]
	})

	return tunnelHTMLBareAttrURLPattern.ReplaceAllStringFunc(input, func(match string) string {
		parts := tunnelHTMLBareAttrURLPattern.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		rewritten := rewriteTunnelBodyURL(parts[2], tunnel)
		if rewritten == parts[2] {
			return match
		}
		return parts[1] + rewritten
	})
}

func rewriteTunnelCSSBody(input string, tunnel *gatewayv1.TunnelSummary) string {
	return tunnelCSSURLPattern.ReplaceAllStringFunc(input, func(match string) string {
		parts := tunnelCSSURLPattern.FindStringSubmatch(match)
		if len(parts) != 5 {
			return match
		}
		rewritten := rewriteTunnelBodyURL(strings.TrimSpace(parts[3]), tunnel)
		if rewritten == strings.TrimSpace(parts[3]) {
			return match
		}
		return parts[1] + parts[2] + rewritten + parts[4]
	})
}

func rewriteTunnelJavaScriptBody(input string, tunnel *gatewayv1.TunnelSummary) string {
	return tunnelJSQuotedURLPattern.ReplaceAllStringFunc(input, func(match string) string {
		parts := tunnelJSQuotedURLPattern.FindStringSubmatch(match)
		if len(parts) != 4 || parts[1] != parts[3] {
			return match
		}
		rewritten := rewriteTunnelBodyURL(parts[2], tunnel)
		if rewritten == parts[2] {
			return match
		}
		return parts[1] + rewritten + parts[1]
	})
}

func rewriteTunnelBodyURL(value string, tunnel *gatewayv1.TunnelSummary) string {
	prefix := tunnelPublicPathPrefix(tunnel)
	if prefix == "" {
		return value
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" ||
		strings.HasPrefix(trimmed, "#") ||
		strings.HasPrefix(trimmed, "//") {
		return value
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return value
	}
	target, targetErr := url.Parse(tunnel.GetTargetUrl())
	if parsed.IsAbs() {
		if targetErr != nil || target.Host == "" {
			return value
		}
		if !strings.EqualFold(parsed.Scheme, target.Scheme) ||
			!strings.EqualFold(parsed.Host, target.Host) {
			return value
		}
		path := stripTunnelTargetBasePath(parsed.EscapedPath(), target.EscapedPath())
		return appendTunnelURLQueryAndFragment(prefix+pathOrRoot(path), parsed)
	}
	if !strings.HasPrefix(trimmed, "/") {
		return value
	}
	if trimmed == prefix || strings.HasPrefix(trimmed, prefix+"/") {
		return value
	}

	path := parsed.EscapedPath()
	if targetErr == nil && target.Host != "" {
		path = stripTunnelTargetBasePath(path, target.EscapedPath())
	}
	return appendTunnelURLQueryAndFragment(prefix+pathOrRoot(path), parsed)
}

func tunnelPublicPathPrefix(tunnel *gatewayv1.TunnelSummary) string {
	if tunnel == nil {
		return ""
	}
	slug := strings.TrimSpace(tunnel.GetSlug())
	if slug == "" {
		return ""
	}
	return "/t/" + slug
}

func pathOrRoot(path string) string {
	if strings.TrimSpace(path) == "" {
		return "/"
	}
	return path
}

func appendTunnelURLQueryAndFragment(path string, parsed *url.URL) string {
	if parsed == nil {
		return path
	}
	if parsed.RawQuery != "" {
		path += "?" + parsed.RawQuery
	}
	if parsed.Fragment != "" {
		path += "#" + parsed.EscapedFragment()
	}
	return path
}
