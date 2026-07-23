package testutil

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/session"
)

type AccountFixture struct {
	Service             *account.Service
	ControllerSession   *account.Session
	Device              *account.Device
	Selection           *account.SelectionLease
	DeviceManager       *session.Manager
	SelectionCredential string
}

func NewAccountFixture(t testing.TB, root *session.Manager) *AccountFixture {
	t.Helper()
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/login":
			_, _ = fmt.Fprint(w, `{"code":0,"message":"success","data":{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600,"user":{"id":1,"email":"one@example.com"}}}`)
		case "/api/v1/user/step-up/consume":
			_, _ = fmt.Fprint(w, `{"code":0,"message":"success","data":{"valid":true,"user_id":1}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(usa.Close)

	service := account.NewService(
		account.NewMemoryStore(),
		account.NewUSAClientWithHTTPClient(usa.URL, usa.Client()),
		time.Hour,
		time.Hour,
	)
	_, controller, err := service.Login(context.Background(), "one@example.com", "password")
	if err != nil {
		t.Fatalf("login account fixture: %v", err)
	}
	device, credential, err := service.RegisterDevice(context.Background(), controller.UserID, account.RegisterDeviceInput{
		InstallationID: "installation-1",
		Name:           "Desktop",
		Platform:       "windows",
		Version:        "1.0.0",
		Workspaces: []account.Workspace{{
			ID: "workspace-1", Name: "Project", Path: "/workspace/project",
		}},
	})
	if err != nil {
		t.Fatalf("register account fixture device: %v", err)
	}
	if _, err := service.AuthenticateDevice(context.Background(), device.ID, credential); err != nil {
		t.Fatalf("authenticate account fixture device: %v", err)
	}
	target := account.TargetFingerprint(account.RuntimeKindDeviceAgent, device.ID, "workspace-1")
	selection, err := service.SelectTarget(context.Background(), controller, account.SelectTargetInput{
		Proof:       "proof-1",
		RuntimeKind: account.RuntimeKindDeviceAgent,
		DeviceID:    device.ID,
		WorkspaceID: "workspace-1",
		Target:      target,
	})
	if err != nil {
		t.Fatalf("select account fixture device: %v", err)
	}
	payload, err := json.Marshal(map[string]string{
		"lease": selection.ID, "runtimeKind": selection.RuntimeKind,
		"deviceId": selection.DeviceID, "workspaceId": selection.WorkspaceID,
	})
	if err != nil {
		t.Fatalf("encode account fixture selection: %v", err)
	}
	return &AccountFixture{
		Service: service, ControllerSession: controller, Device: device, Selection: selection,
		DeviceManager:       root.DeviceManager(controller.UserID, device.ID),
		SelectionCredential: "selection." + base64.RawURLEncoding.EncodeToString(payload),
	}
}

func (f *AccountFixture) Authorize(request *http.Request) {
	request.Header.Set("Authorization", "Bearer "+f.SelectionCredential)
	request.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: f.ControllerSession.ID})
}
