<template>
  <div class="app-resource-picker">
    <details v-for="app in apps" :key="app.value" class="app-resource-group">
      <summary>{{ app.label }} <span>（{{ selectedCount(groups[app.value] || []) }}/{{ (groups[app.value] || []).length }}）</span></summary>
      <div class="app-resource-items">
        <a-checkbox
          v-for="item in groups[app.value] || []"
          :key="objectKey(item)"
          :model-value="selectedObjects.includes(objectKey(item))"
          @change="checked => toggle(objectKey(item), checked)"
        >{{ item.kind }} · {{ item.namespace ? `${item.namespace}/` : '' }}{{ item.name }}{{ item.helmRelease ? ' · Helm release' : '' }}</a-checkbox>
      </div>
    </details>
  </div>
</template>

<script setup>
import { objectKey } from './app-selection'

const props = defineProps({ apps: Array, groups: Object, selectedObjects: Array })
const emit = defineEmits(['update:selectedObjects'])
const selectedCount = items => items.filter(item => props.selectedObjects.includes(objectKey(item))).length
function toggle(key, checked) {
  emit('update:selectedObjects', checked ? [...props.selectedObjects, key] : props.selectedObjects.filter(item => item !== key))
}
</script>
