package main

import (
	"context"
	"log"
	"os"
)

func main() {
	if len(os.Args) == 3 && os.Args[1] == "recovery-owner" {
		if err := runRecoveryOwner(context.Background(), os.Args[2], os.Stdin, os.Stdout); err != nil {
			log.Fatal("Go recovery owner command failed")
		}
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "run-ledger" {
		if err := runLedger(context.Background(), os.Args[2], os.Stdin, os.Stdout); err != nil {
			log.Fatal("Go Run ledger controller failed")
		}
		return
	}
	if len(os.Args) == 4 && os.Args[1] == "business" {
		if err := runBusiness(os.Args[2], os.Args[3]); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 4 && os.Args[1] == "authority" {
		if err := runAuthority(os.Args[2], os.Args[3]); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) > 2 || (len(os.Args) == 2 && os.Args[1] != "temporal") {
		log.Fatal("invalid Bento orchestrator command")
	}
	if err := runTemporal(); err != nil {
		log.Fatal(err)
	}
}
