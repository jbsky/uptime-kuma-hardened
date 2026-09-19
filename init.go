// Uptime Kuma hardened init -- remplace le dumb-init + healthcheck Go de
// l'image officielle, et le shell qu'elle suppose. Binaire statique, aucun
// shell au runtime.
//
// Usage :
//
//	init --setup-dirs       cree /app/data et /tmp (RUN du stage final)
//	init --healthcheck      GET /api/entry-page, exit 0/1
//	init [ARGS...]          entrypoint : pre-verifications puis exec node
package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	kumaUID  = 3001
	kumaGID  = 3001
	nodeBin  = "/usr/bin/node"
	appDir   = "/app"
	server   = "server/server.js"
	pingBin  = "/bin/ping"
	pingSysc = "/proc/sys/net/ipv4/ping_group_range"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--setup-dirs":
			if err := setupDirs(); err != nil {
				fmt.Fprintf(os.Stderr, "[init][ERROR] setup-dirs: %v\n", err)
				os.Exit(1)
			}
			return
		case "--healthcheck":
			os.Exit(healthcheck())
		}
	}
	if err := entrypoint(); err != nil {
		fmt.Fprintf(os.Stderr, "[init][ERROR] %v\n", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// Setup directories -- appele au build, la ou il n'y a plus de shell pour un
// mkdir. /app/data est ensuite masque par le volume en production : ce qui
// compte alors est le proprietaire du repertoire de l'hote, que l'entrypoint
// verifie par une ecriture reelle.
// ---------------------------------------------------------------------------

func setupDirs() error {
	dirs := []struct {
		path string
		mode os.FileMode
		uid  int
		gid  int
	}{
		{appDir + "/data", 0o750, kumaUID, kumaGID},
		{"/tmp", 0o1777, 0, 0},
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d.path, d.mode); err != nil {
			return fmt.Errorf("mkdir %s: %w", d.path, err)
		}
		// MkdirAll passe par l'umask : le mode est repose explicitement.
		if err := os.Chmod(d.path, d.mode); err != nil {
			return fmt.Errorf("chmod %s: %w", d.path, err)
		}
		if err := os.Chown(d.path, d.uid, d.gid); err != nil {
			return fmt.Errorf("chown %s: %w", d.path, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Healthcheck : /api/entry-page lit les reglages en base. Une reponse JSON
// avec un champ "type" prouve qu'express route et que la base repond, ce
// qu'un connect TCP sur 3001 ne dit pas.
// ---------------------------------------------------------------------------

func healthcheck() int {
	url := healthURL()
	client := &http.Client{
		Timeout: 10 * time.Second,
		// Certificat servi par Kuma lui-meme (UPTIME_KUMA_SSL_*) : on
		// interroge 127.0.0.1, le nom ne peut pas correspondre.
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // #nosec G402 -- boucle locale
		},
	}

	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[healthcheck] GET %s: %v\n", url, err)
		return 1
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "[healthcheck] GET %s: HTTP %d\n", url, resp.StatusCode)
		return 1
	}
	var body struct {
		Type string `json:"type"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Type == "" {
		fmt.Fprintf(os.Stderr, "[healthcheck] GET %s: reponse sans champ type (%v)\n", url, err)
		return 1
	}
	return 0
}

// healthURL reprend les variables que lit Kuma (server/config.js) : un port
// ou TLS change cote serveur doit changer aussi cote sonde.
func healthURL() string {
	port := firstEnv("3001", "UPTIME_KUMA_PORT", "PORT")
	// Kubernetes injecte UPTIME_KUMA_PORT=tcp://ip:port pour un Service nomme
	// uptime-kuma : ce n'est pas un port, Kuma l'ignore et nous aussi.
	if _, err := strconv.Atoi(port); err != nil {
		port = "3001"
	}
	scheme := "http"
	if firstEnv("", "UPTIME_KUMA_SSL_KEY", "SSL_KEY") != "" &&
		firstEnv("", "UPTIME_KUMA_SSL_CERT", "SSL_CERT") != "" {
		scheme = "https"
	}
	return scheme + "://127.0.0.1:" + port + "/api/entry-page"
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

func entrypoint() error {
	// Commande complete passee en argument (node extra/reset-password.js...) :
	// exec directe, sans les pre-verifications du serveur.
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		return execProcess(os.Args[1:])
	}

	dataDir := env("DATA_DIR", appDir+"/data/")
	if !filepath.IsAbs(dataDir) {
		dataDir = filepath.Join(appDir, dataDir)
	}
	if !exists(dataDir) {
		return fmt.Errorf("repertoire de donnees absent : %s", dataDir)
	}
	if !writeOK(dataDir) {
		return fmt.Errorf("%s n'accepte pas d'ecriture pour l'uid %d -- "+
			"le volume de l'hote doit appartenir a %d:%d (chown -R %d:%d <repertoire>)",
			dataDir, os.Getuid(), kumaUID, kumaGID, kumaUID, kumaGID)
	}

	if err := checkDBConfig(filepath.Join(dataDir, "db-config.json")); err != nil {
		return err
	}
	warnPing()

	args := []string{nodeBin, server}
	args = append(args, os.Args[1:]...)
	log("data=%s | exec %s", dataDir, strings.Join(args, " "))
	return execProcess(args)
}

// checkDBConfig refuse de demarrer sur une base que l'image ne sait pas
// servir. MariaDB embarque exige le binaire mariadbd, absent ici : sans ce
// controle, Kuma demarre, echoue a lancer le processus et reste sur la page
// de configuration -- un service en etat degrade, pas un echec visible.
func checkDBConfig(path string) error {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		log("pas de %s : premier demarrage, Kuma proposera le choix de la base", filepath.Base(path))
		return nil
	}
	if err != nil {
		return fmt.Errorf("lecture %s : %w", path, err)
	}
	var cfg struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("%s illisible : %w", path, err)
	}
	switch cfg.Type {
	case "sqlite", "mariadb":
		return nil
	case "embedded-mariadb":
		return fmt.Errorf("%s : type embedded-mariadb non supporte par cette image "+
			"(aucun mariadbd embarque) -- utiliser sqlite ou un MariaDB externe", path)
	default:
		return fmt.Errorf("%s : type de base inconnu %q", path, cfg.Type)
	}
}

// warnPing previent, sans bloquer, quand les sondes ping ne pourront pas
// ouvrir de socket. ping est lance sans capacite : il ouvre un socket ICMP
// datagramme, que le noyau n'accorde qu'aux groupes couverts par
// net.ipv4.ping_group_range. Docker l'ouvre a tous par defaut, Podman le
// restreint au groupe 0. Les autres sondes marchent quand meme, d'ou un
// avertissement et pas un refus de demarrer.
func warnPing() {
	if !exists(pingBin) {
		return
	}
	raw, err := os.ReadFile(pingSysc)
	if err != nil {
		return
	}
	lo, hi, ok := parseRange(string(raw))
	gid := os.Getgid()
	if ok && gid >= lo && gid <= hi {
		return
	}
	log("ATTENTION : net.ipv4.ping_group_range = %q ne couvre pas le gid %d -- "+
		"les sondes ping echoueront. Podman : --sysctl net.ipv4.ping_group_range=\"%d %d\"",
		strings.TrimSpace(string(raw)), gid, gid, gid)
}

func parseRange(s string) (lo, hi int, ok bool) {
	f := strings.Fields(s)
	if len(f) != 2 {
		return 0, 0, false
	}
	lo, err1 := strconv.Atoi(f[0])
	hi, err2 := strconv.Atoi(f[1])
	if err1 != nil || err2 != nil || lo > hi {
		return 0, 0, false
	}
	return lo, hi, true
}

// ---------------------------------------------------------------------------
// Helpers -- vocabulaire commun des init.go du parc : env, exists, writeOK.
// ---------------------------------------------------------------------------

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func firstEnv(fallback string, keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return fallback
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// writeOK dit si un repertoire accepte reellement une ecriture. mkdir + chmod
// + chown peuvent tous reussir sur un point de montage en lecture seule :
// seule une ecriture le prouve.
func writeOK(dir string) bool {
	tmp, err := os.CreateTemp(dir, ".write-test-*")
	if err != nil {
		return false
	}
	name := tmp.Name()
	tmp.Close()
	os.Remove(name)
	return true
}

func execProcess(args []string) error {
	bin := args[0]
	if !strings.HasPrefix(bin, "/") {
		var err error
		bin, err = exec.LookPath(bin)
		if err != nil {
			return fmt.Errorf("commande introuvable : %s", args[0])
		}
	}
	if err := os.Chdir(appDir); err != nil {
		return fmt.Errorf("chdir %s: %w", appDir, err)
	}
	return syscall.Exec(bin, args, os.Environ())
}

func log(format string, a ...any) {
	fmt.Printf("[init] "+format+"\n", a...)
}
