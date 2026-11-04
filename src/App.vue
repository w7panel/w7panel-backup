<template>
  <main class="backup-app">
    <a-alert v-if="error" type="error" closable class="notice" @close="error = ''">{{ error }}</a-alert>
    <section v-if="!ready && !loading" class="prerequisite">
      <icon-cloud-download class="prerequisite-icon" />
      <div><h2>尚未发现 Velero</h2><p>默认检测 velero 命名空间；请先安装 Velero、S3 插件，并为当前 k8s-proxy 身份授予读取 Deployment、Namespace、管理 Velero CRD 与 {{ veleroNamespace }} Secret 的权限。</p></div>
      <a-button type="primary" @click="load">重新检测</a-button>
    </section>

    <template v-else-if="ready">
      <a-tabs v-model:active-key="tab" class="workspace-tabs">
        <template #extra><a-button :loading="loading" @click="load"><template #icon><icon-refresh /></template>刷新</a-button></template>
        <a-tab-pane key="backups" title="备份库">
          <section class="toolbar"><div><h2>备份库</h2><p>资源清单备份，不包含卷数据或快照；包含当前对象存储同步到本集群的备份。</p></div><a-space><a-input-search v-model="backupSearch" allow-clear placeholder="筛选备份" /><a-button type="primary" @click="openBackup"><template #icon><icon-plus /></template>创建备份</a-button></a-space></section>
          <a-table :data="visibleBackups" :pagination="{ pageSize: 8 }" row-key="metadata.name" :loading="loading">
            <template #columns><a-table-column title="备份名称" data-index="metadata.name"><template #cell="{ record }"><strong>{{ record.metadata.name }}</strong><small>{{ formatDate(record.metadata.creationTimestamp) }}</small></template></a-table-column><a-table-column title="范围"><template #cell="{ record }">{{ scope(record.spec?.includedNamespaces) }}</template></a-table-column><a-table-column title="状态"><template #cell="{ record }"><a-tag :color="statusColor(record.status?.phase)">{{ record.status?.phase || '等待中' }}</a-tag></template></a-table-column><a-table-column title="保留至"><template #cell="{ record }">{{ formatDate(record.status?.expiration) }}</template></a-table-column><a-table-column title="操作" :width="300"><template #cell="{ record }"><a-space><a-button size="mini" @click="openBackupDetail(record)">详情</a-button><a-tooltip :content="downloadIssue(record) || '下载完整备份归档'" mini><span><a-button size="mini" :disabled="Boolean(downloadIssue(record))" :loading="downloading === record.metadata.name" @click="downloadBackup(record)">下载</a-button></span></a-tooltip><a-button size="mini" @click="openRestore(record)">恢复</a-button><a-popconfirm content="将删除备份记录和远程备份数据，是否继续？" type="warning" @ok="destroy('backups', record.metadata.name)"><a-button size="mini" status="danger" :disabled="backupLocation(record)?.spec?.accessMode === 'ReadOnly'">删除</a-button></a-popconfirm></a-space></template></a-table-column></template>
          </a-table>
        </a-tab-pane>
        <a-tab-pane key="restores" title="恢复记录">
          <section class="toolbar"><div><h2>恢复记录</h2><p>同名对象保留；应用恢复可包含 Helm Chart 的集群范围资源。</p></div></section>
          <a-table :data="restores" :pagination="{ pageSize: 8 }" row-key="metadata.name"><template #columns><a-table-column title="恢复名称" data-index="metadata.name" /><a-table-column title="来源备份" data-index="spec.backupName" /><a-table-column title="状态"><template #cell="{ record }"><a-tag :color="statusColor(record.status?.phase)">{{ record.status?.phase || '等待中' }}</a-tag></template></a-table-column><a-table-column title="创建时间"><template #cell="{ record }">{{ formatDate(record.metadata.creationTimestamp) }}</template></a-table-column><a-table-column title="操作"><template #cell="{ record }"><a-space><a-button size="mini" @click="openRestoreDetail(record)">详情</a-button><a-popconfirm content="删除恢复记录不会回滚已恢复的资源。" @ok="destroy('restores', record.metadata.name)"><a-button size="mini" status="danger">删除记录</a-button></a-popconfirm></a-space></template></a-table-column></template></a-table>
        </a-tab-pane>
        <a-tab-pane key="schedules" title="定时任务">
          <section class="toolbar"><div><h2>定时备份</h2><p>以 Cron 表达式维护备份节奏。</p></div><a-button type="primary" @click="openSchedule()"><template #icon><icon-plus /></template>新建计划</a-button></section>
          <a-table :data="schedules" :pagination="false" row-key="metadata.name"><template #columns><a-table-column title="计划名称" data-index="metadata.name" /><a-table-column title="Cron" data-index="spec.schedule" /><a-table-column title="范围"><template #cell="{ record }">{{ scope(record.spec?.template?.includedNamespaces) }}</template></a-table-column><a-table-column title="状态"><template #cell="{ record }"><a-tag :color="record.spec?.paused ? 'orange' : 'green'">{{ record.metadata?.annotations?.['backup.w7panel.io/sync-error'] ? '资源同步失败' : record.spec?.paused ? '已暂停' : '已启用' }}</a-tag></template></a-table-column><a-table-column title="操作" :width="250"><template #cell="{ record }"><a-space><a-button size="mini" @click="openSchedule(record)">编辑</a-button><a-button size="mini" @click="toggleSchedule(record)">{{ record.spec?.paused ? '恢复' : '暂停' }}</a-button><a-popconfirm content="删除后不再自动创建备份。" @ok="destroy('schedules', record.metadata.name)"><a-button size="mini" status="danger">删除</a-button></a-popconfirm></a-space></template></a-table-column></template></a-table>
        </a-tab-pane>
        <a-tab-pane key="locations" title="存储位置">
          <section class="toolbar"><div><h2>对象存储</h2><p>存储位置由部署配置管理，页面只读。</p></div></section>
          <a-table :data="locations" :pagination="false" row-key="metadata.name"><template #columns><a-table-column title="位置" data-index="metadata.name"><template #cell="{ record }"><strong>{{ record.metadata.name }}</strong><a-tag v-if="record.spec?.default" color="green" size="small">默认</a-tag></template></a-table-column><a-table-column title="Bucket"><template #cell="{ record }">{{ record.spec?.objectStorage?.bucket }}</template></a-table-column><a-table-column title="Endpoint"><template #cell="{ record }">{{ record.spec?.config?.s3Url }}</template></a-table-column><a-table-column title="模式"><template #cell="{ record }"><a-tag :color="record.spec?.accessMode === 'ReadOnly' ? 'orange' : 'green'">{{ record.spec?.accessMode || 'ReadWrite' }}</a-tag></template></a-table-column><a-table-column title="状态"><template #cell="{ record }"><a-tag :color="statusColor(record.status?.phase)">{{ record.status?.phase || '未知' }}</a-tag></template></a-table-column></template></a-table>
        </a-tab-pane>
      </a-tabs>
    </template>

    <a-modal v-model:visible="dialogs.detail" title="备份详情" :footer="false" :width="900"><template v-if="backupDetail"><a-descriptions :column="2" bordered size="small"><a-descriptions-item label="备份名称">{{ backupDetail.metadata?.name }}</a-descriptions-item><a-descriptions-item label="状态"><a-tag :color="statusColor(backupDetail.status?.phase)">{{ backupDetail.status?.phase || '等待中' }}</a-tag></a-descriptions-item><a-descriptions-item label="备份条目">{{ backupDetail.status?.progress?.itemsBackedUp ?? 0 }} / {{ backupDetail.status?.progress?.totalItems ?? '—' }}</a-descriptions-item><a-descriptions-item label="存储位置">{{ backupDetail.spec?.storageLocation || defaultLocation || '—' }}</a-descriptions-item><a-descriptions-item label="开始时间">{{ formatDate(backupDetail.status?.startTimestamp) }}</a-descriptions-item><a-descriptions-item label="完成时间">{{ formatDate(backupDetail.status?.completionTimestamp) }}</a-descriptions-item><a-descriptions-item label="命名空间" :span="2">{{ detailScope(backupDetail.spec?.includedNamespaces, backupDetail.spec?.excludedNamespaces, '命名空间') }}</a-descriptions-item></a-descriptions><h3 class="detail-title">归档资源（{{ backupDetailObjects.length }}）</h3><a-table :data="backupDetailObjects" :pagination="{ pageSize: 10 }" :row-key="objectKey"><template #columns><a-table-column title="类型" data-index="kind" /><a-table-column title="命名空间"><template #cell="{ record }">{{ record.namespace || '集群范围' }}</template></a-table-column><a-table-column title="名称" data-index="name" /></template></a-table><p class="detail-note">只展示资源名称，不展示 Secret 内容；卷数据不包含在本备份中。</p></template></a-modal>
    <a-modal v-model:visible="dialogs.restoreDetail" title="恢复详情" :footer="false" :width="900"><template v-if="restoreDetail"><p>状态：{{ restoreDetail.status?.phase || '等待中' }}；已恢复 {{ restoreDetail.status?.progress?.itemsRestored ?? 0 }} 项</p><p v-if="restoreDetail.metadata?.annotations?.['backup.w7panel.io/hydration-error']">AppGroup 状态补回失败：{{ restoreDetail.metadata.annotations['backup.w7panel.io/hydration-error'] }}</p><h3 class="detail-title">对象结果</h3><a-table :data="restoreDetailResults.items" :pagination="{ pageSize: 10 }" :row-key="item => `${item.resource}/${item.name}`"><template #columns><a-table-column title="资源" data-index="resource" /><a-table-column title="名称" data-index="name" /><a-table-column title="结果" data-index="status" /></template></a-table><h3 v-if="restoreDetailSkipped.length" class="detail-title">已存在，跳过（{{ restoreDetailSkipped.length }}）</h3><p v-for="item in restoreDetailSkipped" :key="item">{{ item }}</p><p v-for="message in restoreDetailResults.errors" :key="message" class="notice">错误：{{ message }}</p><p v-for="message in restoreDetailResults.warnings" :key="message">警告：{{ message }}</p></template></a-modal>
    <a-modal v-model:visible="dialogs.backup" title="创建备份" :width="900" :confirm-loading="saving" ok-text="创建备份" @ok="saveBackup"><a-form :model="backupForm" layout="vertical"><a-form-item label="备份名称" required><a-input v-model="backupForm.name" placeholder="例如 nightly-default" /></a-form-item><a-form-item label="范围模式"><a-radio-group v-model="backupForm.mode" type="button"><a-radio value="app">按应用</a-radio><a-radio value="classic">按集群资源</a-radio></a-radio-group></a-form-item><template v-if="backupForm.mode === 'app'"><a-form-item label="命名空间" required><a-select v-model="backupForm.appNamespace" :options="namespaceOptions" allow-search placeholder="先选择命名空间" @change="() => onAppNamespaceChanged(backupForm)" /></a-form-item><a-form-item label="应用组" required><a-select v-model="backupForm.appKeys" :options="appOptionsFor(backupForm.appNamespace)" :disabled="!backupForm.appNamespace" multiple allow-search placeholder="选择 W7Panel 应用组" @change="value => onAppsSelected(backupForm, value)" /></a-form-item><a-form-item label="关联资源（默认全选）"><a-checkbox-group v-model="backupForm.selectedObjects" :options="objectOptions(backupForm.appObjects)" /></a-form-item></template><template v-else><a-form-item label="命名空间范围"><div class="scope-field"><a-radio-group v-model="backupForm.namespaceMode" type="button" class="scope-mode"><a-radio value="include">仅备份选择项</a-radio><a-radio value="exclude">忽略选择项</a-radio></a-radio-group><a-select v-model="backupForm.namespaces" :options="namespaceOptions" multiple allow-search allow-clear :placeholder="backupForm.namespaceMode === 'include' ? '留空表示全部命名空间' : '选择要忽略的命名空间'" /></div></a-form-item><a-form-item label="资源范围"><div class="scope-field"><a-radio-group v-model="backupForm.resourceMode" type="button" class="scope-mode"><a-radio value="include">仅备份选择项</a-radio><a-radio value="exclude">忽略选择项</a-radio></a-radio-group><a-select v-model="backupForm.resources" :options="resourceOptions" :loading="resourceLoading" multiple allow-search allow-clear :placeholder="backupForm.resourceMode === 'include' ? '留空表示全部资源' : '选择要忽略的资源'" /></div></a-form-item></template><a-form-item label="保留天数"><a-input-number v-model="backupForm.days" :min="1" :max="365" /></a-form-item></a-form></a-modal>
    <a-modal v-model:visible="dialogs.restore" title="从备份恢复" :width="900" :confirm-loading="saving" ok-text="开始恢复" @ok="saveRestore"><a-alert type="info" class="modal-alert">恢复会写入当前 W7Panel 连接的集群。跨集群时，请在目标集群中连接同一对象存储后操作。</a-alert><a-alert type="warning" class="modal-alert">默认保留现有同名资源；按命名空间恢复不包含集群范围资源。</a-alert><a-form :model="restoreForm" layout="vertical"><a-form-item label="恢复名称" required><a-input v-model="restoreForm.name" /></a-form-item><a-form-item label="来源备份"><a-input v-model="restoreForm.backupName" disabled /></a-form-item><template v-if="restoreForm.appObjects?.length"><a-form-item label="命名空间" required><a-select v-model="restoreForm.appNamespace" :options="archiveNamespaceOptions(restoreForm.appObjects)" allow-search placeholder="先选择命名空间" @change="onRestoreNamespaceChanged" /></a-form-item><a-form-item label="应用组" required><a-select v-model="restoreForm.appIds" :options="archiveAppOptions(restoreForm.appObjects).filter(item => item.namespace === restoreForm.appNamespace)" :disabled="!restoreForm.appNamespace" multiple allow-search placeholder="选择要恢复的应用组" @change="value => onArchiveAppsSelected(value)" /></a-form-item><a-form-item label="恢复资源（默认全选）"><a-checkbox-group v-model="restoreForm.selectedObjects" :options="objectOptions(archiveObjectsForApps(restoreForm.appObjects, restoreForm.appIds))" /></a-form-item></template><template v-else><scope-picker v-model="restoreForm.namespaces" :items="namespaceNames" /></template><a-form-item label="命名空间映射"><a-input v-model="restoreForm.mappingText" placeholder="例如 default=restored（每行一组，可选）" type="textarea" :auto-size="{ minRows: 2, maxRows: 5 }" /></a-form-item></a-form></a-modal>
    <a-modal v-model:visible="dialogs.schedule" :title="scheduleForm.original ? '编辑定时备份' : '新建定时备份'" :width="900" :confirm-loading="saving" ok-text="保存计划" @ok="saveSchedule"><a-form :model="scheduleForm" layout="vertical"><a-form-item label="计划名称" required><a-input v-model="scheduleForm.name" :disabled="Boolean(scheduleForm.original)" /></a-form-item><a-form-item label="Cron 表达式" required><a-input v-model="scheduleForm.cron" placeholder="0 2 * * *" /></a-form-item><a-form-item label="范围模式"><a-radio-group v-model="scheduleForm.mode" type="button"><a-radio value="app">按应用</a-radio><a-radio value="classic">按集群资源</a-radio></a-radio-group></a-form-item><template v-if="scheduleForm.mode === 'app'"><a-form-item label="命名空间" required><a-select v-model="scheduleForm.appNamespace" :options="namespaceOptions" allow-search placeholder="先选择命名空间" @change="() => onAppNamespaceChanged(scheduleForm)" /></a-form-item><a-form-item label="应用组" required><a-select v-model="scheduleForm.appKeys" :options="appOptionsFor(scheduleForm.appNamespace)" :disabled="!scheduleForm.appNamespace" multiple allow-search placeholder="选择 W7Panel 应用组" @change="value => onAppsSelected(scheduleForm, value)" /></a-form-item><a-form-item label="关联资源（默认全选）"><a-checkbox-group v-model="scheduleForm.selectedObjects" :options="objectOptions(scheduleForm.appObjects)" /></a-form-item></template><template v-else><a-form-item label="命名空间范围"><div class="scope-field"><a-radio-group v-model="scheduleForm.namespaceMode" type="button" class="scope-mode"><a-radio value="include">仅备份选择项</a-radio><a-radio value="exclude">忽略选择项</a-radio></a-radio-group><a-select v-model="scheduleForm.namespaces" :options="namespaceOptions" multiple allow-search allow-clear :placeholder="scheduleForm.namespaceMode === 'include' ? '留空表示全部命名空间' : '选择要忽略的命名空间'" /></div></a-form-item><a-form-item label="资源范围"><div class="scope-field"><a-radio-group v-model="scheduleForm.resourceMode" type="button" class="scope-mode"><a-radio value="include">仅备份选择项</a-radio><a-radio value="exclude">忽略选择项</a-radio></a-radio-group><a-select v-model="scheduleForm.resources" :options="resourceOptions" :loading="resourceLoading" multiple allow-search allow-clear :placeholder="scheduleForm.resourceMode === 'include' ? '留空表示全部资源' : '选择要忽略的资源'" /></div></a-form-item></template><a-form-item label="保留天数"><a-input-number v-model="scheduleForm.days" :min="1" :max="365" /></a-form-item></a-form></a-modal>
  </main>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, onUnmounted, ref, resolveComponent } from 'vue'
import { backupResource, create, discoverResources, downloadEndpointIssue, downloadRequestResource, get, list, namespaces, remove, restoreLocationIssue, restoreResource, scheduleResource, update, veleroDeployment } from './velero'
import { annotatedApps, appKey, existingObjects, labelId, listAppGroups, liveAppObjects, loadArchiveObjects, loadBackupInventory, loadRestoreResults, markObjects, objectKey, selectedUnion, uniqueObjects } from './app-selection'

const ScopePicker = defineComponent({ props: { modelValue: Array, items: Array }, emits: ['update:modelValue'], setup(props, { emit }) { const FormItem = resolveComponent('a-form-item'), Select = resolveComponent('a-select'); return () => h(FormItem, { label: '命名空间范围' }, { default: () => h(Select, { modelValue: props.modelValue, 'onUpdate:modelValue': value => emit('update:modelValue', value), options: (props.items || []).map(value => ({ label: value, value })), multiple: true, allowClear: true, placeholder: '留空表示全部命名空间' }) }) } })
const veleroNamespace = ref('velero'), tab = ref('backups'), loading = ref(false), saving = ref(false), downloading = ref(''), ready = ref(false), error = ref(''), backupSearch = ref('')
const backups = ref([]), restores = ref([]), schedules = ref([]), locations = ref([]), namespaceNames = ref([]), resourceOptions = ref([]), resourceLoading = ref(false), appGroups = ref([])
const dialogs = ref({ detail: false, restoreDetail: false, backup: false, restore: false, schedule: false, location: false })
const backupForm = ref({}), backupDetail = ref(null), backupDetailObjects = ref([]), restoreDetail = ref(null), restoreDetailResults = ref({ items: [], errors: [], warnings: [] }), restoreForm = ref({}), scheduleForm = ref({}), locationForm = ref({})
const appOptionsFor = namespace => appGroups.value.filter(app => app.metadata.namespace === namespace).map(app => ({ label: app.spec?.title || app.metadata.name, value: appKey(app) }))
const namespaceOptions = computed(() => namespaceNames.value.map(value => ({ label: value, value })))
const defaultLocation = computed(() => locations.value.find(item => item.spec?.default)?.metadata.name || '')
const visibleBackups = computed(() => backups.value.filter(item => item.metadata.name.includes(backupSearch.value.trim())).sort((a, b) => (b.metadata.creationTimestamp || '').localeCompare(a.metadata.creationTimestamp || '')))
const restoreDetailSkipped = computed(() => { try { return JSON.parse(restoreDetail.value?.metadata?.annotations?.['backup.w7panel.io/existing-objects'] || '[]') } catch { return [] } })
const formName = prefix => `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
const scope = value => !value?.length || value.includes('*') ? '全部命名空间' : value.join('、')
const formatDate = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const statusColor = value => ({ Completed: 'green', PartiallyFailed: 'orange', Failed: 'red', FailedValidation: 'red', InProgress: 'arcoblue', New: 'gray' }[value] || 'gray')
const resourceVersion = (resource, body) => ({ ...body, metadata: { ...body.metadata, namespace: veleroNamespace.value, ...(resource?.metadata?.resourceVersion ? { resourceVersion: resource.metadata.resourceVersion } : {}) } })
function resetDialogs() { dialogs.value = { detail: false, restoreDetail: false, backup: false, restore: false, schedule: false, location: false } }
let refreshTimer
const isRunning = item => !['Completed', 'PartiallyFailed', 'Failed', 'FailedValidation'].includes(item.status?.phase)
function queueRefresh() { clearTimeout(refreshTimer); if ([...backups.value, ...restores.value].some(isRunning)) refreshTimer = window.setTimeout(load, 3000) }
async function detectVeleroNamespace() { const candidates = [...new Set(['velero', 'default', veleroNamespace.value])]; for (const namespace of candidates) { try { await veleroDeployment(namespace); veleroNamespace.value = namespace; return } catch (cause) { if (cause.status !== 404) throw cause } } throw new Error('未在 velero 或 default 命名空间发现 Velero Deployment') }
async function load({ detect = false } = {}) { if (loading.value) return; loading.value = true; error.value = ''; try { if (detect) await detectVeleroNamespace(); else await veleroDeployment(veleroNamespace.value); const [b, r, s, l, n] = await Promise.all([list(veleroNamespace.value, 'backups'), list(veleroNamespace.value, 'restores'), list(veleroNamespace.value, 'schedules'), list(veleroNamespace.value, 'backupstoragelocations'), namespaces()]); backups.value = b.items || []; restores.value = r.items || []; schedules.value = s.items || []; locations.value = l.items || []; namespaceNames.value = (n.items || []).map(item => item.metadata.name).sort(); ready.value = true; queueRefresh(); listAppGroups(namespaceNames.value).then(items => { appGroups.value = items }).catch(cause => { error.value = `无法读取 W7Panel 应用组：${cause.message}` }) } catch (cause) { ready.value = false; error.value = cause.message || '无法读取 Velero 资源' } finally { loading.value = false } }
async function loadResourceOptions() { if (resourceOptions.value.length || resourceLoading.value) return; resourceLoading.value = true; try { resourceOptions.value = await discoverResources() } catch (cause) { error.value = `无法发现 Kubernetes 资源：${cause.message}` } finally { resourceLoading.value = false } }
function openBackup() { backupForm.value = { name: `${formName('backup')}-${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`, mode: 'app', appNamespace: 'default', appKeys: [], appObjectGroups: {}, appObjects: [], selectedObjects: [], namespaceMode: 'include', namespaces: [], resourceMode: 'include', resources: [], days: 30 }; dialogs.value.backup = true; loadResourceOptions() }
function detailScope(included, excluded, allLabel) { if (excluded?.length) return `全部${allLabel}（忽略：${excluded.join('、')}）`; return !included?.length || included.includes('*') ? `全部${allLabel}` : included.join('、') }
function backupResourceRules(backup) { const spec = backup?.spec || {}; const rows = []; if (spec.includedResources?.length) rows.push({ mode: '仅备份以下资源', resources: spec.includedResources }); if (spec.excludedResources?.length) rows.push({ mode: '忽略以下资源', resources: spec.excludedResources }); return rows.length ? rows : [{ mode: '资源范围', resources: ['全部资源'] }] }
async function openBackupDetail(backup) { backupDetail.value = backup; backupDetailObjects.value = []; dialogs.value.detail = true; try { backupDetailObjects.value = (await loadBackupInventory(veleroNamespace.value, backup.metadata.name)).items || [] } catch (cause) { error.value = `无法读取备份资源清单：${cause.message}` } }
async function openRestoreDetail(restore) { restoreDetail.value = restore; restoreDetailResults.value = { items: [], errors: [], warnings: [] }; dialogs.value.restoreDetail = true; if (!['Completed', 'PartiallyFailed', 'Failed'].includes(restore.status?.phase)) return; try { restoreDetailResults.value = await loadRestoreResults(veleroNamespace.value, restore.metadata.name) } catch (cause) { error.value = `无法读取恢复结果：${cause.message}` } }
function backupLocation(backup) { return locations.value.find(location => location.metadata?.name === (backup.spec?.storageLocation || defaultLocation.value)) }
function downloadIssue(backup) { if (backup.status?.phase !== 'Completed') return '仅已完成的备份可以下载'; const location = backupLocation(backup); return location ? downloadEndpointIssue(location.spec?.config?.s3Url) : '未找到此备份使用的存储位置' }
const wait = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds))
async function downloadBackup(backup) { const issue = downloadIssue(backup); if (issue) { error.value = issue; return } const popup = window.open('', '_blank'); downloading.value = backup.metadata.name; error.value = ''; try { const name = `download-${Date.now().toString(36)}`; await create(veleroNamespace.value, 'downloadrequests', resourceVersion(null, downloadRequestResource({ name, backupName: backup.metadata.name }))); for (let attempt = 0; attempt < 20; attempt += 1) { await wait(500); const request = await get(veleroNamespace.value, 'downloadrequests', name); if (request.status?.downloadURL) { popup.location.href = request.status.downloadURL; return } } throw new Error('下载文件准备超时，请稍后重试') } catch (cause) { if (popup) popup.close(); error.value = cause.message || '无法准备备份下载' } finally { downloading.value = '' } }
function restoreIssue(backup) { return restoreLocationIssue(backupLocation(backup)) }
function isAppBackup(backup) {
  return annotatedApps(backup.metadata?.annotations).length || [backup.spec?.labelSelector, ...(backup.spec?.orLabelSelectors || [])].some(selector => Object.keys(selector?.matchLabels || {}).some(key => key.startsWith('backup.w7panel.io/app-')))
}
async function openRestore(backup) {
  const issue = restoreIssue(backup)
  if (issue) { error.value = issue; return }
  try {
    const archive = await loadArchiveObjects(veleroNamespace.value, backup.metadata.name)
    const items = archive.items || []
    if (!items.length && isAppBackup(backup)) throw new Error('备份归档中没有可选的应用资源')
    const appIds = [...new Set(items.map(item => item.appId).filter(Boolean))]
    restoreForm.value = { name: formName('restore'), backupName: backup.metadata.name, namespaces: backup.spec?.includedNamespaces?.filter(item => item !== '*') || [], mappingText: '', appObjects: items, appNamespace: '', appIds: [], previousAppIds: [], selectedObjects: [] }
    dialogs.value.restore = true
  } catch (cause) {
    if (isAppBackup(backup)) { error.value = `无法读取新备份的对象清单：${cause.message}`; return }
    restoreForm.value = { name: formName('restore'), backupName: backup.metadata.name, namespaces: backup.spec?.includedNamespaces?.filter(item => item !== '*') || [], mappingText: '', appObjects: [] }
    dialogs.value.restore = true
  }
}
async function openSchedule(record) {
  const template = record?.spec.template || {}
  const appKeys = annotatedApps(record?.metadata?.annotations)
  const apps = appKeys.map(key => appGroups.value.find(app => appKey(app) === key))
  if (apps.some(app => !app)) { error.value = '无法读取计划关联的应用组'; return }
  let groups = {}
  try { groups = Object.fromEntries(await Promise.all(apps.map(async app => [appKey(app), await liveAppObjects(app, veleroNamespace.value)]))) }
  catch (cause) { error.value = `无法读取应用关联资源：${cause.message}`; return }
  const related = uniqueObjects(Object.values(groups).flat())
  scheduleForm.value = { mode: appKeys.length ? 'app' : record ? 'classic' : 'app', appNamespace: apps.length && apps.every(app => app.metadata.namespace === apps[0].metadata.namespace) ? apps[0].metadata.namespace : '', appKeys, appObjectGroups: groups, appObjects: related, selectedObjects: related.map(objectKey), original: record, name: record?.metadata.name || formName('daily'), cron: record?.spec.schedule || '0 2 * * *', namespaceMode: template.excludedNamespaces?.length ? 'exclude' : 'include', namespaces: (template.excludedNamespaces || template.includedNamespaces || []).filter(item => item !== '*'), resourceMode: template.excludedResources?.length ? 'exclude' : 'include', resources: template.excludedResources || template.includedResources || [], storageLocation: template.storageLocation || defaultLocation.value, days: Math.round((template.ttl ? Number(String(template.ttl).match(/\d+/)?.[0]) : 720) / 24) }
  if (appKeys.length) {
    const selectors = template.orLabelSelectors || [template.labelSelector]
    const excluded = selectors.flatMap(selector => selector?.matchExpressions?.find(item => item.key === 'backup.w7panel.io/object-id')?.values || [])
    scheduleForm.value.selectedObjects = (await Promise.all(related.map(async item => ({ key: objectKey(item), id: await labelId(objectKey(item)) })))).filter(item => !excluded.includes(item.id)).map(item => item.key)
  }
  dialogs.value.schedule = true
  loadResourceOptions()
}
function objectOptions(items = []) { return items.map(item => ({ label: `${item.kind} · ${item.namespace ? `${item.namespace}/` : ''}${item.name}${item.helmRelease ? ' · Helm release' : ''}`, value: objectKey(item) })) }
function archiveAppOptions(items = []) {
  const names = new Map(items.filter(item => item.kind === 'AppGroup').map(item => [item.appId, item.name]))
  return [...new Set(items.map(item => item.appId).filter(Boolean))].map(value => ({ label: names.get(value) || value, value, namespace: items.find(item => item.appId === value && item.kind === 'AppGroup')?.namespace || items.find(item => item.appId === value)?.namespace }))
}
function archiveNamespaceOptions(items = []) { return [...new Set(archiveAppOptions(items).map(item => item.namespace).filter(Boolean))].sort().map(value => ({ label: value, value })) }
function archiveObjectsForApps(items = [], appIds = []) { return uniqueObjects(items.filter(item => appIds.includes(item.appId))) }
function onRestoreNamespaceChanged() { restoreForm.value.appIds = []; restoreForm.value.previousAppIds = []; restoreForm.value.selectedObjects = [] }
function onArchiveAppsSelected(appIds) {
  const form = restoreForm.value
  form.selectedObjects = selectedUnion(archiveObjectsForApps(form.appObjects, form.previousAppIds), form.selectedObjects, archiveObjectsForApps(form.appObjects, appIds))
  form.previousAppIds = [...appIds]
}
function onAppNamespaceChanged(form) { form.appKeys = []; form.appObjectGroups = {}; form.appObjects = []; form.selectedObjects = [] }
async function onAppsSelected(form, keys) {
  const previousGroups = form.appObjectGroups || {}
  const previous = uniqueObjects(Object.values(previousGroups).flat())
  resourceLoading.value = true
  try {
    const groups = Object.fromEntries(await Promise.all(keys.map(async key => {
      const app = appGroups.value.find(item => appKey(item) === key)
      if (!app) throw new Error(`找不到应用组 ${key}`)
      return [key, previousGroups[key] || await liveAppObjects(app, veleroNamespace.value)]
    })))
    if (JSON.stringify(form.appKeys) !== JSON.stringify(keys)) return
    const objects = uniqueObjects(Object.values(groups).flat())
    form.selectedObjects = selectedUnion(previous, form.selectedObjects, objects)
    form.appObjectGroups = groups
    form.appObjects = objects
  } catch (cause) {
    if (JSON.stringify(form.appKeys) === JSON.stringify(keys)) form.appKeys = Object.keys(previousGroups)
    error.value = `无法读取应用关联资源：${cause.message}`
  } finally { resourceLoading.value = false }
}
async function selectedAppScope(form, markAll = false) {
  const apps = form.appKeys.map(key => appGroups.value.find(app => appKey(app) === key))
  if (!apps.length || apps.some(app => !app)) throw new Error('请选择应用组')
  const selected = form.appObjects.filter(item => form.selectedObjects.includes(objectKey(item)))
  if (!selected.length) throw new Error('至少选择一个资源')
  const appIds = []
  for (const app of apps) {
    const objects = form.appObjectGroups[appKey(app)].filter(item => markAll || form.selectedObjects.includes(objectKey(item)))
    appIds.push((await markObjects(app, objects)).appId)
  }
  return { selected, appIds, objectIds: await Promise.all(selected.map(item => labelId(objectKey(item)))), namespaces: [...new Set(selected.map(item => item.namespace).filter(Boolean))] }
}
function appAnnotations(keys) { return { 'backup.w7panel.io/appgroups': JSON.stringify(keys) } }
async function saveBackup() { await savingAction(async () => {
  if (!defaultLocation.value) throw new Error('未配置默认存储位置')
  let options = { ...backupForm.value, storageLocation: defaultLocation.value, ttlHours: backupForm.value.days * 24 }
  let metadata = {}
  if (backupForm.value.mode === 'app') {
    const { namespaces, objectIds } = await selectedAppScope(backupForm.value)
    options = { ...options, namespaces, namespaceMode: 'include', resources: [], objectIds }
    metadata = { annotations: appAnnotations(backupForm.value.appKeys) }
  }
  const body = backupResource(options)
  body.metadata = { ...body.metadata, ...metadata }
  await create(veleroNamespace.value, 'backups', resourceVersion(null, body))
  resetDialogs(); await load()
}) }
function mappings(value) { return Object.fromEntries(String(value || '').split('\n').map(line => line.split('=').map(part => part.trim())).filter(parts => parts.length === 2 && parts[0] && parts[1])) }
async function saveRestore() { await savingAction(async () => {
  const backup = backups.value.find(item => item.metadata.name === restoreForm.value.backupName)
  const issue = restoreIssue(backup || { spec: {} })
  if (issue) throw new Error(issue)
  const form = restoreForm.value
  const selected = form.appObjects?.length ? archiveObjectsForApps(form.appObjects, form.appIds).filter(item => form.selectedObjects.includes(objectKey(item))) : null
  if (form.appObjects?.length && (!form.appIds.length || !selected.length)) throw new Error('至少选择一个应用组和恢复资源')
  const mapping = mappings(form.mappingText)
  if (selected?.some(item => item.helmRelease) && Object.keys(mapping).length) throw new Error('恢复 Helm release 时必须使用原命名空间')
  const existing = selected ? await existingObjects(selected, mapping) : []
  if (existing.length && !window.confirm(`以下 ${existing.length} 个同名资源已存在，恢复时会跳过：\n${existing.slice(0, 12).map(item => `${item.kind} ${mapping[item.namespace] || item.namespace}/${item.name}`).join('\n')}${existing.length > 12 ? '\n…' : ''}\n\n继续恢复吗？`)) return
  const existingAppGroups = existing.filter(item => item.kind === 'AppGroup').map(item => `${mapping[item.namespace] || item.namespace}/${item.name}`)
  const existingObjectKeys = existing.map(objectKey)
  if (JSON.stringify(existingObjectKeys).length > 180000) throw new Error('同名资源过多，无法安全记录跳过清单')
  const body = restoreResource({ ...form, namespaces: selected ? [...new Set(selected.map(item => item.namespace).filter(Boolean))] : form.namespaces, objectIds: selected?.map(item => item.id), mapping, existingAppGroups, existingObjectKeys })
  await create(veleroNamespace.value, 'restores', resourceVersion(null, body))
  resetDialogs(); tab.value = 'restores'; await load()
}) }
async function saveSchedule() { await savingAction(async () => {
  if (!defaultLocation.value) throw new Error('未配置默认存储位置')
  let options = { ...scheduleForm.value, storageLocation: defaultLocation.value, ttlHours: scheduleForm.value.days * 24, paused: scheduleForm.value.original?.spec?.paused }
  const annotations = { ...(scheduleForm.value.original?.metadata?.annotations || {}) }
  if (scheduleForm.value.mode === 'app') {
    const { appIds } = await selectedAppScope(scheduleForm.value, true)
    options = { ...options, namespaces: ['*'], namespaceMode: 'include', resources: [], appIds, excludedObjectIds: await Promise.all(scheduleForm.value.appObjects.filter(item => !scheduleForm.value.selectedObjects.includes(objectKey(item))).map(item => labelId(objectKey(item)))) }
    Object.assign(annotations, appAnnotations(scheduleForm.value.appKeys))
    delete annotations['backup.w7panel.io/app-namespace']; delete annotations['backup.w7panel.io/app-name']
  } else {
    delete annotations['backup.w7panel.io/appgroups']; delete annotations['backup.w7panel.io/app-namespace']; delete annotations['backup.w7panel.io/app-name']
  }
  const body = resourceVersion(scheduleForm.value.original, scheduleResource(options))
  body.metadata.annotations = annotations
  if (scheduleForm.value.original) await update(veleroNamespace.value, 'schedules', scheduleForm.value.name, body)
  else await create(veleroNamespace.value, 'schedules', body)
  resetDialogs(); await load()
}) }
async function toggleSchedule(record) { await savingAction(async () => { if (record.metadata?.annotations?.['backup.w7panel.io/sync-error']) throw new Error('应用资源同步失败，请先修复后再启用计划'); const body = resourceVersion(record, { ...record, spec: { ...record.spec, paused: !record.spec?.paused } }); await update(veleroNamespace.value, 'schedules', record.metadata.name, body); await load() }) }
async function destroy(resource, name) { await savingAction(async () => { await remove(veleroNamespace.value, resource, name); await load() }) }
async function savingAction(action) { saving.value = true; error.value = ''; try { await action() } catch (cause) { error.value = cause.message || '操作失败' } finally { saving.value = false } }
onMounted(() => load({ detect: true }))
onUnmounted(() => clearTimeout(refreshTimer))
</script>
