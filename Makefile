.PHONY: check fmt lint test snapshots audit deny

check: fmt lint test snapshots audit deny

fmt:
	cd apps/tui && cargo fmt

lint:
	cd apps/tui && cargo clippy -- -D warnings

test:
	cd apps/tui && cargo test

snapshots:
	cd apps/tui && cargo insta pending-snapshots

audit:
	cd apps/tui && cargo audit

deny:
	# --config はバージョンによって置き場所が変わる (cargo-deny 0.20 で root へ移動)。
	# リポジトリ直下で実行すれば deny.toml を既定で拾うため、--config を渡さない。
	cargo deny --manifest-path apps/tui/Cargo.toml check
