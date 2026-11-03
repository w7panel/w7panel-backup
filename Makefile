.PHONY: push-zpk

push-zpk:
	curl -L --fail -o /usr/local/bin/zpk https://github.com/w7panel/w7panel-zpk/releases/download/latest/zpk_linux_amd64
	chmod +x /usr/local/bin/zpk
	@zpk login --username=w7admin --password="$${ZPK_IDC_PASSWORD}" --host=zpk.idc.w7.com
	zpk use w7panel-backup
	zpk attach add --path=./w7panel-backup-$(CNB_BRANCH).tgz --type=helm
	zpk attach add --path=./dist/dist.zip --type=frontend
	zpk push
