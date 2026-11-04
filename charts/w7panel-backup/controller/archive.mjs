import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'

const appLabel = 'backup.w7panel.io/app-'
const objectLabel = 'backup.w7panel.io/object-id'

async function* tarEntries(stream) {
  let buffer = Buffer.alloc(0)
  let remaining = 0
  let padding = 0
  let name = ''
  let parts = []
  let collect = false
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length) {
      if (padding) { const take = Math.min(padding, buffer.length); buffer = buffer.subarray(take); padding -= take; if (padding) break }
      if (!remaining) {
        if (buffer.length < 512) break
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512)
        if (header.every(byte => byte === 0)) return
        name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
        const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8)
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar entry size')
        remaining = size
        padding = (512 - size % 512) % 512
        collect = name.endsWith('.json') && size <= 2 * 1024 * 1024
        parts = []
        if (!size) continue
      }
      const take = Math.min(remaining, buffer.length)
      if (collect) parts.push(buffer.subarray(0, take))
      buffer = buffer.subarray(take)
      remaining -= take
      if (!remaining && collect) yield { name, data: Buffer.concat(parts) }
    }
  }
}

async function* archiveEntries(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`Backup archive download failed: ${response.status}`)
  for await (const entry of tarEntries(Readable.fromWeb(response.body).pipe(createGunzip()))) {
    if (!entry.name.startsWith('resources/')) continue
    try {
      const object = JSON.parse(entry.data)
      if (object.apiVersion && object.kind && object.metadata?.name) yield object
    } catch { /* unrelated archive JSON */ }
  }
}

export async function archiveAppGroups(url, objectIds) {
  const found = []
  for await (const object of archiveEntries(url)) {
    if (object.kind === 'AppGroup' && object.metadata.labels?.[objectLabel] && objectIds.includes(object.metadata.labels[objectLabel])) found.push(object)
  }
  return [...new Map(found.map(object => [`${object.metadata.namespace}/${object.metadata.name}`, object])).values()]
}

export async function archiveInventory(url) {
  const found = new Map()
  for await (const object of archiveEntries(url)) {
    const value = { apiVersion: object.apiVersion, kind: object.kind, namespace: object.metadata.namespace || '', name: object.metadata.name }
    found.set(`${value.apiVersion}/${value.kind}/${value.namespace}/${value.name}`, value)
  }
  return [...found.values()]
}

export async function archiveObjects(url, appIds) {
  const found = new Map()
  for await (const object of archiveEntries(url)) {
      const labels = object.metadata?.labels || {}
      if (!labels[objectLabel]) continue
      for (const appId of appIds) {
        if (labels[`${appLabel}${appId}`] !== 'true') continue
        const value = { apiVersion: object.apiVersion, kind: object.kind, namespace: object.metadata.namespace || '', name: object.metadata.name, id: labels[objectLabel], appId, ...(object.type === 'helm.sh/release.v1' ? { helmRelease: true } : {}) }
        found.set(`${value.apiVersion}/${value.kind}/${value.namespace}/${value.name}/${appId}`, value)
      }
  }
  return [...found.values()]
}
