package pbws

import (
	"testing"

	"github.com/liveagent/agent-gateway/internal/account"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func TestDeviceWorkspaceGuard(t *testing.T) {
	conn := &browserConn{
		selectionScope: account.SelectionScopeDevice,
		allowedWorkspaces: []account.Workspace{
			{ID: "project-a", Path: "E:/code/project-a"},
			{ID: "archived", Path: "E:/code/archived", Archived: true},
		},
	}
	if err := conn.vetChatWorkdir("e:/code/project-a"); err != nil {
		t.Fatalf("published project rejected: %v", err)
	}
	if err := conn.vetChatWorkdir("E:/code/other"); err == nil {
		t.Fatal("unpublished workdir accepted")
	}
	if err := conn.vetChatWorkdir("E:/code/project-a/../other"); err == nil {
		t.Fatal("traversal workdir accepted")
	}
	if err := conn.vetChatWorkdir("E:/code/archived"); err == nil {
		t.Fatal("archived project accepted")
	}
	if err := conn.vetPlainChat("text", "", nil); err != nil {
		t.Fatalf("plain chat rejected: %v", err)
	}
	if err := conn.vetPlainChat("tools", "", nil); err == nil {
		t.Fatal("plain chat accepted tools execution mode")
	}
	if err := conn.vetPlainChat("text", "", []string{"custom"}); err == nil {
		t.Fatal("plain chat accepted project tools")
	}
}

func TestWorkspaceGuardRejectsRemoteProjectCreation(t *testing.T) {
	conn := &browserConn{
		selectionScope:    account.SelectionScopeDevice,
		allowedWorkspaces: []account.Workspace{{ID: "project-a", Path: "/repo/a"}},
	}
	env := &gatewayv1.GatewayEnvelope{
		Payload: &gatewayv1.GatewayEnvelope_FsCreateProjectFolder{
			FsCreateProjectFolder: &gatewayv1.FsCreateProjectFolderRequest{
				Parent: "/repo",
				Name:   "new",
			},
		},
	}
	if err := conn.vetWorkspaceAgentRequest(env); err == nil {
		t.Fatal("remote project creation accepted")
	}
}
