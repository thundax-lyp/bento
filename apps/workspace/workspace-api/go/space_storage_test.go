package main

import (
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"slices"
	"strings"
	"testing"
)

func TestSpacePartSignatureBindsBody(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "verification")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "EXAMPLE_TEST_KEY")
	t.Setenv("AWS_SESSION_TOKEN", "")
	storage, err := newSpaceStorage(t.Context(), "http://127.0.0.1:8421", "verification", "")
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("a test part")
	digest := sha256.Sum256(data)
	checksum := base64.StdEncoding.EncodeToString(digest[:])
	signed, err := storage.signPart(t.Context(), spaceObjectKey("fixture"), "test-upload", 1, int64(len(data)), checksum)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	headers := strings.Split(query.Get("X-Amz-SignedHeaders"), ";")
	if !slices.Contains(headers, "x-amz-checksum-sha256") || !slices.Contains(headers, "content-length") ||
		query.Has("x-amz-checksum-sha256") || query.Get("X-Amz-Expires") != "600" ||
		query.Get("uploadId") != "test-upload" || query.Get("partNumber") != "1" ||
		parsed.Path != "/verification/space/fixture" {
		t.Fatal("presigned request is missing required constraints")
	}
}
