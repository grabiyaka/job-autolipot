<template>
  <button class="bool-input" :class="{ checked: modelValue }" type="button" role="switch" :aria-checked="modelValue" :aria-label="label" :disabled="disabled" @click="$emit('update:modelValue', !modelValue)">
    <AppIcon v-if="modelValue" name="check" />
  </button>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import AppIcon from './AppIcon.vue';

export default defineComponent({
  components: { AppIcon },
  props: {
    modelValue: { type: Boolean, required: true },
    label: { type: String, required: true },
    disabled: { type: Boolean, default: false },
  },
  emits: { 'update:modelValue': (value: boolean) => typeof value === 'boolean' },
});
</script>

<style lang="scss" scoped>
.bool-input {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  padding: 2px;
  border: 1px solid $line;
  border-radius: 7px;
  background: white;
  color: white;

  &.checked {
    background: $primary;
    border-color: $primary;
  }
}
</style>
