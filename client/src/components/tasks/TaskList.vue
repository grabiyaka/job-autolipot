<template>
  <main class="task-page">
    <header class="page-heading">
      <div><p class="eyebrow">От планов к действиям</p><h1>Задачи <span v-if="canReadTasks && loaded">{{ total }}</span></h1><p>Держите важное в фокусе. Двигайтесь шаг за шагом.</p></div>
      <button v-if="canManageTasks" class="button primary" type="button" :disabled="!!busyTaskId || saving" @click="createTask"><AppIcon name="plus" /> Новая задача</button>
    </header>

    <section v-if="!canReadTasks" class="empty-state" aria-labelledby="access-heading"><AppIcon name="lock" /><h2 id="access-heading">Доступ ещё не выдан</h2><p>Обратитесь к администратору, чтобы получить доступ к задачам.</p><RouterLink class="button" to="/profile">Мой профиль</RouterLink></section>
    <template v-else>
      <p v-if="notice" class="message success" role="status">{{ notice }}</p>
      <p v-if="error" class="message error" role="alert">{{ error }} <button class="button quiet" type="button" :disabled="loading" @click="loadTasks">Повторить</button></p>
      <section class="task-board" aria-label="Список задач" :aria-busy="loading">
        <header class="board-toolbar">
          <h2>Все задачи</h2>
          <label class="field search"><span class="sr-only">Поиск на текущей странице</span><input v-model="search" type="search" placeholder="Поиск на странице" /><AppIcon name="search" /></label>
          <label class="field filter"><span class="sr-only">Статус на текущей странице</span><select v-model="statusFilter"><option value="">Все статусы</option><option value="OPEN">Открыты</option><option value="IN_PROGRESS">В работе</option><option value="DONE">Готовы</option></select></label>
        </header>

        <p v-if="search || statusFilter" class="filter-note">Поиск и фильтр применяются к текущей странице. <button type="button" @click="resetFilters">Сбросить</button></p>
        <p v-if="loading" class="loading" role="status">Загружаем задачи…</p>
        <section v-else-if="!tasks.length && !error" class="empty-state" aria-labelledby="empty-heading"><span class="empty-icon"><AppIcon name="tasks" /></span><h2 id="empty-heading">{{ canManageTasks ? 'Дайте планам начало' : 'Пока нет задач' }}</h2><p v-if="canManageTasks">Создайте первую задачу: опишите идею,<br />выберите статус и наметьте следующий шаг.</p><p v-else>Здесь появятся задачи, созданные вашей командой.</p><button v-if="canManageTasks" class="button primary" type="button" :disabled="!!busyTaskId || saving" @click="createTask"><AppIcon name="plus" /> Создать задачу</button></section>
        <p v-else-if="!filteredTasks.length && !error" class="loading">На этой странице ничего не найдено. Попробуйте изменить фильтр.</p>
        <ul v-else class="task-list">
          <li v-for="task in filteredTasks" :key="task.id" :class="{ completed: task.completed }">
            <BoolInput :model-value="task.completed" :label="`Выполнение задачи: ${task.title}`" :disabled="!canManageTasks || !!busyTaskId" @update:model-value="toggleTask(task, $event)" />
            <div class="task-summary"><strong>{{ task.title }}</strong><span v-if="task.description">{{ task.description }}</span><small><span v-if="task.dueAt"><AppIcon name="calendar" /> {{ formatDate(task.dueAt) }}</span><span v-for="(tag, index) in task.tags" :key="index" class="tag">{{ tag }}</span></small></div>
            <span class="status" :class="task.status.toLowerCase()">{{ statusLabel(task.status) }}</span>
            <span class="priority" :title="`Приоритет: ${task.priority}`">P{{ task.priority }}</span>
            <button v-if="canManageTasks" class="button quiet icon" type="button" :aria-label="`Изменить задачу: ${task.title}`" :disabled="!!busyTaskId" @click="editTask(task)"><AppIcon name="edit" /></button>
            <button v-if="canDeleteTasks" class="button quiet icon delete" type="button" :aria-label="`Удалить задачу: ${task.title}`" :disabled="!!busyTaskId" @click="confirmDelete(task)"><AppIcon name="trash" /></button>
          </li>
        </ul>

        <footer v-if="loaded && total" class="pagination">
          <p>{{ firstItem }}–{{ lastItem }} из {{ total }}<span v-if="search || statusFilter"> · найдено на странице: {{ filteredTasks.length }}</span></p>
          <nav aria-label="Страницы задач"><button class="button icon previous" type="button" aria-label="Предыдущая страница" :disabled="page <= 1 || loading" @click="changePage(-1)"><AppIcon name="chevron" /></button><span>{{ page }} / {{ totalPages }}</span><button class="button icon" type="button" aria-label="Следующая страница" :disabled="page >= totalPages || loading" @click="changePage(1)"><AppIcon name="chevron" /></button></nav>
        </footer>
      </section>
    </template>

    <AppDialog v-if="canManageTasks && formOpen" :title="editingTask ? 'Изменить задачу' : 'Новая задача'" heading-id="task-form-title" :busy="saving" @close="closeForm"><TaskForm :task="editingTask" :saving="saving" :error="formError" @save="saveTask" @cancel="closeForm" /></AppDialog>
    <AppDialog v-if="canDeleteTasks && deletingTask" title="Удалить задачу?" heading-id="task-delete-title" :busy="saving" @close="deletingTask = null"><p class="delete-description">«{{ deletingTask.title }}» будет удалена. Это действие нельзя отменить.</p><p v-if="formError" class="message error" role="alert">{{ formError }}</p><footer class="delete-actions"><button class="button" type="button" :disabled="saving" @click="deletingTask = null">Оставить</button><button class="button danger" type="button" :disabled="saving" @click="deleteTask">{{ saving ? 'Удаляем…' : 'Удалить задачу' }}</button></footer></AppDialog>
  </main>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import { useUserStore } from '@/store/user';
import { errorMessage, request } from '@/mixin/fetch';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppDialog from '@/components/ui/AppDialog.vue';
import BoolInput from '@/components/ui/BoolInput.vue';
import TaskForm from './TaskForm.vue';
import type { Task, TaskPage, CreateTaskInput } from './TaskTypes';

export default defineComponent({
  components: { AppIcon, AppDialog, BoolInput, TaskForm },
  data: () => ({
    tasks: [] as Task[], total: 0, page: 1, limit: 10, loaded: false,
    loading: false, saving: false, busyTaskId: '', error: '', notice: '',
    search: '', statusFilter: '', formOpen: false, formError: '',
    editingTask: null as Task | null, deletingTask: null as Task | null,
    loadVersion: 0,
  }),
  computed: {
    ...mapState(useUserStore, ['canReadTasks', 'canManageTasks', 'canDeleteTasks']),
    filteredTasks(): Task[] {
      const query = this.search.toLocaleLowerCase().trim();
      return this.tasks.filter((task) => (!this.statusFilter || task.status === this.statusFilter)
        && (!query || [task.title, task.description ?? '', ...task.tags].join(' ').toLocaleLowerCase().includes(query)));
    },
    totalPages(): number { return Math.max(1, Math.ceil(this.total / this.limit)); },
    firstItem(): number { return this.total ? (this.page - 1) * this.limit + 1 : 0; },
    lastItem(): number { return Math.min(this.page * this.limit, this.total); },
  },
  mounted() {
    if (this.canReadTasks) void this.loadTasks();
  },
  beforeUnmount() { this.loadVersion += 1; },
  methods: {
    async loadTasks() {
      if (!this.canReadTasks) return;
      const version = ++this.loadVersion;
      this.loading = true;
      this.error = '';
      try {
        const query = new URLSearchParams({ page: String(this.page), limit: String(this.limit) });
        const result = await request<TaskPage>(`/api/tasks?${query}`);
        if (version !== this.loadVersion) return;
        this.tasks = result.items;
        this.total = result.total;
        this.loaded = true;
        if (this.page > this.totalPages) {
          this.page = this.totalPages;
          await this.loadTasks();
        }
      } catch (error) {
        if (version === this.loadVersion) this.error = errorMessage(error);
      } finally {
        if (version === this.loadVersion) this.loading = false;
      }
    },
    resetFilters() { this.search = ''; this.statusFilter = ''; },
    async changePage(direction: number) {
      this.page += direction;
      this.resetFilters();
      await this.loadTasks();
    },
    createTask() {
      if (!this.canManageTasks || this.busyTaskId || this.saving) return;
      this.editingTask = null;
      this.formError = '';
      this.formOpen = true;
    },
    async editTask(task: Task) {
      if (!this.canManageTasks || this.busyTaskId || this.saving) return;
      this.busyTaskId = task.id;
      this.error = '';
      try {
        this.editingTask = await request<Task>(`/api/tasks/${encodeURIComponent(task.id)}`);
        this.formError = '';
        this.formOpen = true;
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.busyTaskId = '';
      }
    },
    closeForm() { if (!this.saving) this.formOpen = false; },
    async saveTask(input: CreateTaskInput) {
      if (!this.canManageTasks || this.saving) return;
      this.saving = true;
      this.formError = '';
      try {
        await request<Task>(this.editingTask ? `/api/tasks/${encodeURIComponent(this.editingTask.id)}` : '/api/tasks', {
          method: this.editingTask ? 'PATCH' : 'POST', body: input,
        });
        this.notice = this.editingTask ? 'Изменения сохранены.' : 'Задача создана.';
        this.formOpen = false;
        this.resetFilters();
        await this.loadTasks();
      } catch (error) {
        this.formError = errorMessage(error);
      } finally {
        this.saving = false;
      }
    },
    async toggleTask(task: Task, completed: boolean) {
      if (!this.canManageTasks || this.busyTaskId || this.saving) return;
      this.busyTaskId = task.id;
      this.error = '';
      try {
        const updated = await request<Task>(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { completed } });
        this.tasks = this.tasks.map((item) => item.id === updated.id ? updated : item);
        this.notice = completed ? 'Задача отмечена как выполненная.' : 'Отметка о выполнении снята.';
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.busyTaskId = '';
      }
    },
    confirmDelete(task: Task) {
      if (!this.canDeleteTasks || this.busyTaskId || this.saving) return;
      this.formError = '';
      this.deletingTask = task;
    },
    async deleteTask() {
      if (!this.canDeleteTasks || !this.deletingTask || this.saving) return;
      this.saving = true;
      this.formError = '';
      try {
        await request<void>(`/api/tasks/${encodeURIComponent(this.deletingTask.id)}`, { method: 'DELETE' });
        this.deletingTask = null;
        this.notice = 'Задача удалена.';
        await this.loadTasks();
      } catch (error) {
        this.formError = errorMessage(error);
      } finally {
        this.saving = false;
      }
    },
    statusLabel(status: Task['status']): string {
      return { OPEN: 'Открыта', IN_PROGRESS: 'В работе', DONE: 'Готова' }[status];
    },
    formatDate(value: string): string {
      return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
    },
  },
});
</script>

<style lang="scss" scoped>
.task-page {
  padding: 43px 42px;

  @include responsive(1000px) {
    padding: 34px 24px;
  }

  @include responsive(650px) {
    padding: 27px 20px;
  }

  .page-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 25px;
    margin-bottom: 34px;

    @include responsive(1000px) {
      align-items: flex-start;
      flex-direction: column;
      gap: 20px;
    }

    h1 {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 11px;
      font-size: 32px;
      font-weight: 650;
      letter-spacing: -0.05em;

      span {
        padding: 4px 9px;
        border: 1px solid $line;
        border-radius: 7px;
        background: white;
        color: $muted;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
      }
    }

    p:not(.eyebrow) {
      margin-top: 12px;
      color: $muted;
      font-size: 13px;
    }
  }

  > .message {
    margin-bottom: 18px;
  }

  .task-board {
    overflow: hidden;
    border: 1px solid $line;
    border-radius: 12px;
    background: white;

    .board-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 22px;
      border-bottom: 1px solid $line;

      @include responsive(1000px) {
        flex-wrap: wrap;
      }

      @include responsive(480px) {
        padding: 18px;
      }

      h2 {
        flex: 1;
        font-size: 15px;
        font-weight: 650;

        @include responsive(1000px) {
          flex-basis: 100%;
          margin-bottom: 8px;
        }
      }

      .search {
        position: relative;
        width: 235px;

        @include responsive(1000px) {
          flex: 1;
        }

        @include responsive(480px) {
          flex-basis: 100%;
        }

        .app-icon {
          position: absolute;
          top: 14px;
          right: 12px;
          width: 15px;
          height: 15px;
          color: $muted;
          pointer-events: none;
        }
      }

      .filter {
        width: 144px;

        @include responsive(480px) {
          width: 100%;
        }
      }
    }

    .filter-note {
      padding: 12px 22px;
      border-bottom: 1px solid $line;
      color: $muted;
      font-size: 12px;

      button {
        padding: 0;
        border: 0;
        background: none;
        color: $primary;
      }
    }

    .loading {
      padding: 70px 24px;
      color: $muted;
      text-align: center;
    }

    .task-list {
      margin: 0;
      padding: 0;
      list-style: none;

      li {
        display: flex;
        align-items: center;
        gap: 15px;
        min-height: 98px;
        padding: 20px 22px;

        @include responsive(1100px) {
          gap: 10px;
        }

        @include responsive(850px) {
          flex-wrap: wrap;
        }

        &:not(:last-child) {
          border-bottom: 1px solid $line;
        }

        &.completed {
          .task-summary > strong {
            color: $muted;
            text-decoration: line-through;
          }
        }

        .task-summary {
          display: flex;
          flex: 1;
          flex-direction: column;
          gap: 5px;
          min-width: 0;
          padding: 0;
          border: 0;
          background: none;
          color: $ink;
          text-align: left;

          @include responsive(850px) {
            flex-basis: calc(100% - 48px);
          }

          > strong, > span {
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          > strong {
            font-size: 14px;
            font-weight: 600;
          }

          > span {
            color: $muted;
            font-size: 12px;
          }

          small {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            margin-top: 3px;
            color: $muted;
            font-size: 10px;

            &:empty {
              display: none;
            }

            span {
              display: inline-flex;
              align-items: center;
              gap: 4px;
              overflow-wrap: anywhere;
            }

            .app-icon {
              width: 12px;
              height: 12px;
            }

            .tag {
              padding: 2px 6px;
              border-radius: 4px;
              background: $canvas;
            }
          }
        }

        .status {
          padding: 5px 9px;
          border-radius: 6px;
          color: $muted;
          background: $canvas;
          font-size: 11px;
          white-space: nowrap;

          @include responsive(850px) {
            margin-left: 34px;
          }

          &.in_progress {
            color: $primary;
            background: $primary-soft;
          }

          &.done {
            color: $success;
            background: $success-soft;
          }
        }

        .priority {
          max-width: 90px;
          overflow-wrap: anywhere;
          color: $muted;
          font-size: 11px;

          @include responsive(850px) {
            margin-right: auto;
          }
        }

        .delete:hover {
          color: $danger;
          background: $danger-soft;
        }
      }
    }

    .pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      padding: 16px 22px;
      border-top: 1px solid $line;
      color: $muted;
      font-size: 11px;

      @include responsive(480px) {
        align-items: flex-start;
        flex-direction: column;
      }

      nav {
        display: flex;
        align-items: center;
        gap: 12px;

        .button {
          min-width: 32px;
          min-height: 32px;
          padding: 6px;

          .app-icon {
            width: 15px;
            height: 15px;
          }

          &.previous .app-icon {
            transform: rotate(180deg);
          }
        }
      }
    }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    padding: 75px 24px 85px;
    text-align: center;

    @include responsive(650px) {
      padding: 50px 20px;
    }

    .empty-icon {
      display: grid;
      place-items: center;
      width: 62px;
      height: 62px;
      margin-bottom: 5px;
      border-radius: 18px;
      color: $primary;
      background: $primary-soft;

      .app-icon {
        width: 28px;
        height: 28px;
      }
    }

    h2 {
      font-size: 20px;
      letter-spacing: -0.03em;
    }

    p {
      color: $muted;
      font-size: 12px;
      line-height: 1.8;
    }

    .button {
      margin-top: 7px;
    }
  }

  .delete-description {
    margin-bottom: 20px;
    overflow-wrap: anywhere;
    color: $muted;
  }

  .delete-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 25px;
  }
}
</style>
