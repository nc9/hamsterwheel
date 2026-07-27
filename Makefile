BIN_DIR := $(HOME)/.local/bin
CLI     := $(abspath apps/cli/src/index.ts)

.PHONY: link unlink

link: ## symlink the dev CLI as `hamster` in ~/.local/bin
	@chmod +x $(CLI)
	@mkdir -p $(BIN_DIR)
	@ln -sf $(CLI) $(BIN_DIR)/hamster
	@echo "linked $(BIN_DIR)/hamster -> $(CLI)"

unlink:
	@rm -f $(BIN_DIR)/hamster
	@echo "removed $(BIN_DIR)/hamster"
