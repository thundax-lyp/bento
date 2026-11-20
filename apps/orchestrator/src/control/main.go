package main

import (
	"log"
	"os"
)

func main() {
	if len(os.Args) > 2 || (len(os.Args) == 2 && os.Args[1] != "temporal") {
		log.Fatal("invalid Bento orchestrator command")
	}
	if err := runTemporal(); err != nil {
		log.Fatal(err)
	}
}
