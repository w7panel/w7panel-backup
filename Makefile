.PHONY: all build-ui build-helm test local-test push-zpk

CNB_BRANCH ?= $(shell sed -n 's/^version: //p' charts/w7panel-backup/Chart.yaml)
export CNB_BRANCH

all: build-ui build-helm

build-ui:
	npm run build
	cd dist && zip -r dist.zip ./*

build-helm:
	helm package ./charts/w7panel-backup --app-version "$${CNB_BRANCH}" --version "$${CNB_BRANCH}"

test:
	npm test

local-test:
	LOCAL_TEST=1 KUBE_PROXY_PORT=$${KUBE_PROXY_PORT:-18013} INDEX_PORT=$${INDEX_PORT:-18023} npm run dev

push-zpk:
	@test -n "$${CNB_BRANCH}" || { echo 'CNB_BRANCH is required' >&2; exit 1; }
	@test -n "$${ZPK_IDC_PASSWORD}" || { echo 'ZPK_IDC_PASSWORD is required' >&2; exit 1; }
	@test -f "./w7panel-backup-$${CNB_BRANCH}.tgz" || { echo "Missing w7panel-backup-$${CNB_BRANCH}.tgz" >&2; exit 1; }
	@test -f ./dist/dist.zip || { echo 'Missing dist/dist.zip' >&2; exit 1; }
	@command -v zpk >/dev/null 2>&1 || { echo 'zpk is not installed' >&2; exit 1; }
	@zpk --help >/dev/null 2>&1 || { echo 'Installed zpk cannot run' >&2; exit 1; }
	@zpk login --username=w7admin --password="$${ZPK_IDC_PASSWORD}" --host=zpk.idc.w7.com
	zpk use w7panel-backup
	zpk attach add --path=./w7panel-backup-$${CNB_BRANCH}.tgz --type=helm
	zpk attach add --path=./dist/dist.zip --type=frontend
	zpk push
