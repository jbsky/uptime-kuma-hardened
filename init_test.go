package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnv(t *testing.T) {
	const key = "KUMA_INIT_TEST_VAR"

	if got := env(key, "default"); got != "default" {
		t.Errorf("env(%q, %q) = %q, want default value", key, "default", got)
	}

	t.Setenv(key, "custom")
	if got := env(key, "default"); got != "custom" {
		t.Errorf("env(%q, ...) = %q, want %q", key, got, "custom")
	}

	t.Setenv(key, "")
	if got := env(key, "default"); got != "default" {
		t.Errorf("env(%q, ...) with empty value = %q, want fallback %q", key, got, "default")
	}
}

func TestExists(t *testing.T) {
	dir := t.TempDir()
	present := filepath.Join(dir, "present")

	if exists(present) {
		t.Errorf("exists(%q) = true before file creation", present)
	}

	if err := os.WriteFile(present, nil, 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if !exists(present) {
		t.Errorf("exists(%q) = false after file creation", present)
	}

	if exists(filepath.Join(dir, "absent")) {
		t.Errorf("exists() reported true for a path that was never created")
	}
}

func TestWriteOK(t *testing.T) {
	dir := t.TempDir()
	if !writeOK(dir) {
		t.Errorf("writeOK(%q) = false for a writable temp dir", dir)
	}

	if writeOK(filepath.Join(dir, "does-not-exist")) {
		t.Errorf("writeOK() = true for a non-existent directory")
	}
}

func TestParseRange(t *testing.T) {
	cases := []struct {
		in     string
		lo, hi int
		ok     bool
	}{
		{"0 2147483647\n", 0, 2147483647, true},
		{"3001\t3001", 3001, 3001, true},
		{"1 0", 0, 0, false},
		{"", 0, 0, false},
		{"a b", 0, 0, false},
	}
	for _, c := range cases {
		lo, hi, ok := parseRange(c.in)
		if ok != c.ok || (ok && (lo != c.lo || hi != c.hi)) {
			t.Errorf("parseRange(%q) = %d, %d, %v ; attendu %d, %d, %v", c.in, lo, hi, ok, c.lo, c.hi, c.ok)
		}
	}
}

func TestCheckDBConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db-config.json")

	if err := checkDBConfig(path); err != nil {
		t.Errorf("absence de db-config.json (premier demarrage) refusee : %v", err)
	}

	for body, wantErr := range map[string]bool{
		`{"type":"sqlite"}`:           false,
		`{"type":"mariadb"}`:          false,
		`{"type":"embedded-mariadb"}`: true,
		`{"type":"postgres"}`:         true,
		`pas du json`:                 true,
	} {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("setup: %v", err)
		}
		if err := checkDBConfig(path); (err != nil) != wantErr {
			t.Errorf("checkDBConfig(%s) : erreur = %v, attendue = %v", body, err, wantErr)
		}
	}
}

func TestHealthURL(t *testing.T) {
	t.Setenv("UPTIME_KUMA_PORT", "")
	t.Setenv("PORT", "")
	t.Setenv("UPTIME_KUMA_SSL_KEY", "")
	t.Setenv("SSL_KEY", "")
	t.Setenv("UPTIME_KUMA_SSL_CERT", "")
	t.Setenv("SSL_CERT", "")
	if got := healthURL(); got != "http://127.0.0.1:3001/api/entry-page" {
		t.Errorf("defaut : %s", got)
	}

	// Kubernetes injecte tcp://ip:port pour un Service nomme uptime-kuma.
	t.Setenv("UPTIME_KUMA_PORT", "tcp://10.0.0.1:3001")
	if got := healthURL(); got != "http://127.0.0.1:3001/api/entry-page" {
		t.Errorf("variable Kubernetes prise pour un port : %s", got)
	}

	t.Setenv("UPTIME_KUMA_PORT", "4000")
	t.Setenv("UPTIME_KUMA_SSL_KEY", "/k.pem")
	t.Setenv("UPTIME_KUMA_SSL_CERT", "/c.pem")
	if got := healthURL(); got != "https://127.0.0.1:4000/api/entry-page" {
		t.Errorf("port + TLS : %s", got)
	}
}
