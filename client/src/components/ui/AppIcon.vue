<template>
  <svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';

const paths = {
  tasks: 'M9 5H5v14h14V5h-4M9 3h6v4H9zM8 11l1 1 2-2m2 1h3m-8 5 1 1 2-2m2 1h3',
  user: 'M20 21v-2a7 7 0 0 0-14 0v2M17 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  logout: 'M9 4H4v16h5m6-15 7 7-7 7m-6-7h13',
  plus: 'M12 5v14M5 12h14',
  search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  close: 'M6 6l12 12M6 18 18 6',
  chevron: 'm9 5 7 7-7 7',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3',
  check: 'm5 12 4 4L19 6',
  calendar: 'M4 5h16v16H4zM8 3v4m8-4v4M4 11h16',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  edit: 'm15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15z',
} as const;

export default defineComponent({
  props: { name: { type: String as PropType<keyof typeof paths>, required: true } },
  data: () => ({ paths }),
});
</script>

<style lang="scss" scoped>
.app-icon {
  display: inline-block;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
