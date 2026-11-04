.PHONY: all build-ui build-helm build-image test local-test push-zpk full check-version check-release

VERSION ?=
CHART_PACKAGE = ./w7panel-backup-$(if $(VERSION),$(VERSION),$(CNB_BRANCH)).tgz

check-version:
	@test -n "$(VERSION)" || { echo 'Set VERSION=x.y.z' >&2; exit 2; }

check-release: check-version
	@for tool in npm helm zpk zip; do command -v "$$tool" >/dev/null || { echo "Missing $$tool" >&2; exit 2; }; done
	@test -n "$${ZPK_IDC_PASSWORD:-}" || { echo 'Set ZPK_IDC_PASSWORD' >&2; exit 2; }

.NOTPARALLEL: full
full: check-release build-ui build-helm build-image push-zpk

CNB_BRANCH ?= $(shell sed -n 's/^version: //p' charts/w7panel-backup/Chart.yaml)
export CNB_BRANCH

all: build-ui build-helm

build-ui:
	npm run build
	cd dist && rm -f dist.zip && zip -qr dist.zip .

build-helm:
	helm package ./charts/w7panel-backup --app-version "$(if $(VERSION),$(VERSION),$(CNB_BRANCH))" --version "$(if $(VERSION),$(VERSION),$(CNB_BRANCH))"

build-image:
	@echo 'No project image to build'

test:
	npm test

local-test:
	LOCAL_TEST=1 KUBE_PROXY_PORT=$${KUBE_PROXY_PORT:-18013} INDEX_PORT=$${INDEX_PORT:-18023} npm run dev

push-zpk:
	@test -n "$(if $(VERSION),$(VERSION),$(CNB_BRANCH))" || { echo 'Set VERSION or CNB_BRANCH' >&2; exit 1; }
	@test -n "$${ZPK_IDC_PASSWORD}" || { echo 'ZPK_IDC_PASSWORD is required' >&2; exit 1; }
	@test -f "$(CHART_PACKAGE)" || { echo "Missing $(CHART_PACKAGE)" >&2; exit 1; }
	@test -f ./dist/dist.zip || { echo 'Missing dist/dist.zip' >&2; exit 1; }
	@command -v zpk >/dev/null 2>&1 || { echo 'zpk is not installed' >&2; exit 1; }
	@zpk --help >/dev/null 2>&1 || { echo 'Installed zpk cannot run' >&2; exit 1; }
	@zpk login --username=w7admin --password="$${ZPK_IDC_PASSWORD}" --host=zpk.fan.b2.sz.w7.com
	zpk use --name=w7panel-backup
	zpk attach add --path=$(CHART_PACKAGE) --type=helm
	zpk attach add --path=./dist/dist.zip --type=frontend
	zpk push
