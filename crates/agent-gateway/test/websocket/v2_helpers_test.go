package websocket_test

// v2（WebSocket+Protobuf）二进制帧测试 harness：起真实 httptest 服务器、以子协议拨号、
// 按 proto 帧收发。

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

type v2AccountFixture struct {
	accounts      *account.Service
	accessToken   string
	device        *account.Device
	credential    string
	selection     *account.SelectionLease
	deviceManager *session.Manager
}

func newV2AccountFixture(t *testing.T, root *session.Manager) *v2AccountFixture {
	t.Helper()
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/me":
			_, _ = fmt.Fprint(w, `{"code":0,"message":"success","data":{"id":1,"email":"one@example.com"}}`)
		case "/api/v1/user/step-up/consume":
			_, _ = fmt.Fprint(w, `{"code":0,"message":"success","data":{"valid":true,"user_id":1}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(usa.Close)

	store := account.NewMemoryStore()
	accounts := account.NewService(
		store,
		account.NewUSAClientWithHTTPClient(usa.URL, usa.Client()),
		time.Hour,
		time.Hour,
	)
	const accessToken = "account-access-token"
	desktop, err := accounts.DesktopSession(context.Background(), accessToken)
	if err != nil {
		t.Fatalf("create desktop session: %v", err)
	}
	device, credential, err := accounts.RegisterDevice(context.Background(), desktop.UserID, account.RegisterDeviceInput{
		InstallationID: "installation-1",
		Name:           "Desktop",
		Platform:       "windows",
		Version:        "1.0.0",
		Workspaces: []account.Workspace{{
			ID: "workspace-1", Name: "Project", Path: "/workspace/project",
		}},
	})
	if err != nil {
		t.Fatalf("register device: %v", err)
	}
	if _, err := accounts.AuthenticateDevice(context.Background(), device.ID, credential); err != nil {
		t.Fatalf("authenticate device: %v", err)
	}
	target := account.TargetFingerprint(account.RuntimeKindDeviceAgent, device.ID, "workspace-1")
	selection, err := accounts.SelectTarget(context.Background(), desktop, account.SelectTargetInput{
		Proof:       "proof-1",
		RuntimeKind: account.RuntimeKindDeviceAgent,
		DeviceID:    device.ID,
		WorkspaceID: "workspace-1",
		Target:      target,
	})
	if err != nil {
		t.Fatalf("select device: %v", err)
	}
	return &v2AccountFixture{
		accounts: accounts, accessToken: accessToken, device: device, credential: credential,
		selection: selection, deviceManager: root.DeviceManager(desktop.UserID, device.ID),
	}
}

func newV2TestConfig() *config.Config {
	return &config.Config{
		RequestTimeout: time.Second,
	}
}

// dialV2 起服务并以 v2 子协议拨号。
func dialV2(t *testing.T, handler http.Handler) (*websocket.Conn, func()) {
	t.Helper()
	ts := httptest.NewServer(handler)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{pbws.Subprotocol}}
	conn, resp, err := dialer.Dial(wsURL, http.Header{
		"Origin": []string{ts.URL},
	})
	if err != nil {
		ts.Close()
		t.Fatalf("dial v2 websocket: %v", err)
	}
	if got := resp.Header.Get("Sec-Websocket-Protocol"); got != pbws.Subprotocol {
		_ = conn.Close()
		ts.Close()
		t.Fatalf("subprotocol = %q, want %q", got, pbws.Subprotocol)
	}
	return conn, func() {
		_ = conn.Close()
		ts.Close()
	}
}

func sendProtoFrame(t *testing.T, conn *websocket.Conn, frame proto.Message) {
	t.Helper()
	data, err := proto.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal v2 frame: %v", err)
	}
	if err := conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set v2 write deadline: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
		t.Fatalf("send v2 frame: %v", err)
	}
}

// receiveWebFrame 读取一条 WebServerFrame，跳过与断言无关的周期/广播帧（对应 v1 harness
// 过滤集）；带关联 id 的 status 是 status_get / chat_prepare 的响应，不过滤。
func receiveWebFrame(t *testing.T, conn *websocket.Conn) *gatewayv2.WebServerFrame {
	t.Helper()
	for {
		frame := receiveWebFrameRaw(t, conn)
		switch frame.GetPayload().(type) {
		case *gatewayv2.WebServerFrame_Ping,
			*gatewayv2.WebServerFrame_TunnelState,
			*gatewayv2.WebServerFrame_ProcessState:
			continue
		case *gatewayv2.WebServerFrame_Status:
			if frame.GetRequestId() == "" {
				continue
			}
			return frame
		default:
			return frame
		}
	}
}

func receiveWebFrameRaw(t *testing.T, conn *websocket.Conn) *gatewayv2.WebServerFrame {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set v2 read deadline: %v", err)
	}
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("receive v2 frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("v2 frame message type = %d, want binary", messageType)
	}
	var frame gatewayv2.WebServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal v2 frame: %v", err)
	}
	return &frame
}

// receiveWebFrameWithID 等待携带指定关联 id 的帧。
func receiveWebFrameWithID(t *testing.T, conn *websocket.Conn, id string) *gatewayv2.WebServerFrame {
	t.Helper()
	for attempt := 0; attempt < 8; attempt++ {
		frame := receiveWebFrame(t, conn)
		if frame.GetRequestId() == id {
			return frame
		}
	}
	t.Fatalf("timed out waiting for v2 frame id %q", id)
	return nil
}

// helloV2 完成浏览器链路握手并断言成功。
func helloV2(t *testing.T, conn *websocket.Conn, fixture *v2AccountFixture) {
	t.Helper()
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hello-1",
		Payload: &gatewayv2.WebClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           fixture.accessToken,
				ClientName:      "webui-test",
				SelectionLease:  fixture.selection.ID,
				WorkspaceId:     fixture.selection.WorkspaceID,
				RuntimeKind:     fixture.selection.RuntimeKind,
			},
		},
	})
	frame := receiveWebFrameRaw(t, conn)
	hello := frame.GetHello()
	if hello == nil || !hello.GetOk() {
		t.Fatalf("v2 hello reply = %#v, want ok hello", frame)
	}
}

// newV2BrowserTest 建好 manager + 假 agent 会话 + 已握手的浏览器连接。
func newV2BrowserTest(t *testing.T) (*session.Manager, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()

	root := session.NewManager()
	fixture := newV2AccountFixture(t, root)
	sm := fixture.deviceManager
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := pbws.NewServer(newV2TestConfig(), root, fixture.accounts).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	helloV2(t, conn, fixture)
	return sm, agentSession, conn, cleanup
}

// readOutboundEnvelope 取出网关发往桌面端的下一条信封并 Ack。
func readOutboundEnvelope(t *testing.T, agentSession *session.AgentSession) *gatewayv1.GatewayEnvelope {
	t.Helper()
	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		return outbound.GatewayEnvelope
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for gateway request to reach agent")
		return nil
	}
}

// answerChatRuntimeProbe 以假桌面端身份应答 chat.prepare 的关联 Ping 探测。
func answerChatRuntimeProbe(
	t *testing.T,
	sm *session.Manager,
	agentSession *session.AgentSession,
) string {
	t.Helper()
	envelope := readOutboundEnvelope(t, agentSession)
	requestID := envelope.GetRequestId()
	if !strings.HasPrefix(requestID, "chat-runtime-wake-") || envelope.GetPing() == nil {
		t.Fatalf("chat runtime probe = %#v, want chat-runtime-wake-* Ping", envelope)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_Pong{
			Pong: &gatewayv1.PongResponse{Timestamp: envelope.GetPing().GetTimestamp()},
		},
	})
	return requestID
}

// dispatchStarted 以假桌面端身份上报 run 的 started 控制事件。
func dispatchStarted(sm *session.Manager, runID string, conversationID string) {
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: runID,
		Payload: &gatewayv1.AgentEnvelope_ChatControl{
			ChatControl: &gatewayv1.ChatControlEvent{
				RequestId:      runID,
				ConversationId: conversationID,
				Type:           "started",
				State:          "running",
			},
		},
	})
}
