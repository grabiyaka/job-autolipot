<template>
  <dialog ref="dialog" class="app-dialog" :aria-labelledby="headingId" @cancel.prevent="close" @click="onBackdrop">
    <header>
      <h2 :id="headingId">{{ title }}</h2>
      <button class="button quiet icon" type="button" aria-label="Закрыть окно" :disabled="busy" @click="close">
        <AppIcon name="close" />
      </button>
    </header>
    <slot />
  </dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import AppIcon from './AppIcon.vue';

export default defineComponent({
  components: { AppIcon },
  props: {
    title: { type: String, required: true },
    headingId: { type: String, required: true },
    busy: { type: Boolean, default: false },
  },
  emits: ['close'],
  mounted() {
    const dialog = this.$refs.dialog;
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  },
  beforeUnmount() {
    const dialog = this.$refs.dialog;
    if (dialog instanceof HTMLDialogElement) dialog.close();
  },
  methods: {
    close() {
      if (!this.busy) this.$emit('close');
    },
    onBackdrop(event: MouseEvent) {
      if (event.target !== this.$refs.dialog) return;
      const bounds = (event.target as HTMLDialogElement).getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.close();
    },
  },
});
</script>

<style lang="scss" scoped>
.app-dialog {
  width: min(580px, calc(100% - 32px));
  max-height: calc(100dvh - 48px);
  padding: 25px;
  border: 1px solid $line;
  border-radius: 18px;
  color: $ink;
  box-shadow: $shadow;

  @include responsive(600px) {
    max-height: calc(100dvh - 24px);
    padding: 20px;
  }

  &::backdrop {
    background: $backdrop;
    backdrop-filter: blur(3px);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 20px;

    h2 {
      font-size: 21px;
      letter-spacing: -0.04em;
    }
  }
}
</style>
