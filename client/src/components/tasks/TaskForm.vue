<template>
  <form class="task-form" @submit.prevent="submit">
    <label class="field title">Название задачи<input v-model="form.title" name="title" required maxlength="500" autofocus :disabled="saving" placeholder="Что нужно сделать?" /></label>
    <label class="field description">Описание<textarea v-model="form.description" name="description" :disabled="saving" placeholder="Добавьте детали, ссылки или контекст" /></label>
    <label class="field">Статус<select v-model="form.status" name="status" :disabled="saving"><option value="OPEN">Открыта</option><option value="IN_PROGRESS">В работе</option><option value="DONE">Готова</option></select></label>
    <label class="field">Приоритет<input v-model.number="form.priority" name="priority" type="number" step="1" min="-2147483648" max="2147483647" :disabled="saving" required /><small>Чем больше число, тем выше приоритет.</small></label>
    <label class="field date">Срок выполнения<input v-model="form.dueAt" name="dueAt" type="datetime-local" :disabled="saving" /><small>Дата и время в вашем часовом поясе.</small></label>
    <label class="field tags">Метки<input v-model="form.tags" name="tags" :disabled="saving" placeholder="дизайн, планирование" /><small>Разделяйте метки запятыми.</small></label>
    <p class="completed"><BoolInput v-model="form.completed" label="Задача выполнена" :disabled="saving" /> Задача выполнена</p>
    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <footer><button class="button" type="button" :disabled="saving" @click="$emit('cancel')">Отмена</button><button class="button primary" type="submit" :disabled="saving || !form.title.trim()">{{ saving ? 'Сохраняем…' : task ? 'Сохранить изменения' : 'Создать задачу' }}</button></footer>
  </form>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';
import type { Task, CreateTaskInput } from './TaskTypes';
import BoolInput from '@/components/ui/BoolInput.vue';

function localDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default defineComponent({
  components: { BoolInput },
  props: {
    task: { type: Object as PropType<Task | null>, default: null },
    saving: { type: Boolean, default: false },
    error: { type: String, default: '' },
  },
  emits: {
    save: (input: CreateTaskInput) => typeof input.title === 'string',
    cancel: () => true,
  },
  data() {
    return {
      form: {
        title: this.task?.title ?? '',
        description: this.task?.description ?? '',
        status: this.task?.status ?? 'OPEN',
        priority: this.task?.priority ?? 0,
        dueAt: localDateTime(this.task?.dueAt ?? null),
        tags: this.task?.tags.join(', ') ?? '',
        completed: this.task?.completed ?? false,
      },
    };
  },
  methods: {
    submit() {
      if (this.saving || !this.form.title.trim()) return;
      this.$emit('save', {
        title: this.task?.title === this.form.title ? this.task.title : this.form.title.trim(),
        description: (this.task?.description ?? '') === this.form.description && this.task
          ? this.task.description : this.form.description.trim() || null,
        status: this.form.status,
        priority: this.form.priority,
        dueAt: this.task && this.form.dueAt === localDateTime(this.task.dueAt)
          ? this.task.dueAt : this.form.dueAt ? new Date(this.form.dueAt).toISOString() : null,
        tags: this.task && this.form.tags === this.task.tags.join(', ')
          ? [...this.task.tags] : [...new Set(this.form.tags.split(',').map((tag) => tag.trim()).filter(Boolean))],
        completed: this.form.completed,
      });
    },
  },
});
</script>

<style lang="scss" scoped>
.task-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;

  @include responsive(480px) {
    grid-template-columns: 1fr;
  }

  .title, .description, .date, .tags, .completed, .message, footer {
    grid-column: 1 / -1;
  }

  .completed {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 500;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 8px;
    padding-top: 20px;
    border-top: 1px solid $line;

    @include responsive(480px) {
      flex-direction: column-reverse;
    }
  }
}
</style>
