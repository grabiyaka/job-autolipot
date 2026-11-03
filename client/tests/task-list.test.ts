import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../src/mixin/fetch';
import { useUserStore, type SessionUser } from '../src/store/user';
import TaskList from '../src/components/tasks/TaskList.vue';
import TaskForm from '../src/components/tasks/TaskForm.vue';
import type { Task } from '../src/components/tasks/TaskTypes';

vi.mock('../src/mixin/fetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/mixin/fetch')>(), request: vi.fn(),
}));

let wrapper: VueWrapper | undefined;
const task: Task = {
  id: 'task-1', title: 'Исходная задача', description: 'Описание задачи', completed: false,
  priority: 0, status: 'OPEN', dueAt: null, tags: ['work'],
  createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
};
const page = { items: [task], total: 1, page: 1, limit: 10 };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(request).mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

function mountTasks(role: SessionUser['role']) {
  const user = useUserStore();
  user.user = { id: 'user-1', email: 'user@example.test', name: 'Пользователь', role };
  return mount(TaskList, {
    global: {
      plugins: [getActivePinia()!],
      stubs: {
        AppDialog: { template: '<section><slot /></section>' },
        RouterLink: true,
      },
    },
  });
}

describe('task list access and editing', () => {
  it('keeps a pending edit from being replaced by a blank create form', async () => {
    let resolveEdit: (value: Task) => void = () => { throw new Error('Edit request was not initialized'); };
    const pendingEdit = new Promise<Task>((resolve) => { resolveEdit = resolve; });
    vi.mocked(request)
      .mockResolvedValueOnce(page)
      .mockReturnValueOnce(pendingEdit)
      .mockResolvedValueOnce({ ...task, title: 'Обновлённая задача' })
      .mockResolvedValueOnce(page);
    const view = mountTasks('manager');
    wrapper = view;
    await flushPromises();

    await view.get('[aria-label="Изменить задачу: Исходная задача"]').trigger('click');
    const create = view.get('.page-heading button');
    expect(create.attributes()).toHaveProperty('disabled');
    await create.trigger('click');
    view.vm.createTask();
    expect(view.findComponent(TaskForm).exists()).toBe(false);

    resolveEdit(task);
    await flushPromises();
    const form = view.getComponent(TaskForm);
    expect(form.get<HTMLInputElement>('[name="title"]').element.value).toBe('Исходная задача');
    await form.get('[name="title"]').setValue('Обновлённая задача');
    await form.get('form').trigger('submit');
    await flushPromises();

    expect(request).toHaveBeenCalledWith('/api/tasks/task-1', {
      method: 'PATCH', body: expect.objectContaining({ title: 'Обновлённая задача' }),
    });
    expect(vi.mocked(request).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(view.findComponent(TaskForm).exists()).toBe(false);
  });

  it('does not request tasks until a foreign user is granted access', async () => {
    const view = mountTasks('foreign');
    wrapper = view;
    await flushPromises();
    await view.vm.loadTasks();

    expect(request).not.toHaveBeenCalled();
    expect(wrapper.get('#access-heading').text()).toBe('Доступ ещё не выдан');
    expect(wrapper.find('.page-heading button').exists()).toBe(false);
  });

  it.each([
    { role: 'admin', manage: true, remove: true },
    { role: 'manager', manage: true, remove: false },
    { role: 'guest', manage: false, remove: false },
  ] as const)('shows task actions granted to $role', async ({ role, manage, remove }) => {
    vi.mocked(request).mockResolvedValue(page);
    wrapper = mountTasks(role);
    await flushPromises();

    expect(request).toHaveBeenCalledExactlyOnceWith('/api/tasks?page=1&limit=10');
    expect(wrapper.get('.task-summary').text()).toContain(task.title);
    expect(wrapper.get('.task-summary').text()).toContain(task.description);
    expect(wrapper.get('h1').text()).toContain('1');
    expect(wrapper.find('.page-heading button').exists()).toBe(manage);
    expect(wrapper.find('[aria-label="Изменить задачу: Исходная задача"]').exists()).toBe(manage);
    expect(wrapper.find('[aria-label="Удалить задачу: Исходная задача"]').exists()).toBe(remove);
    expect(wrapper.get<HTMLButtonElement>('[role="switch"]').element.disabled).toBe(!manage);
  });

  it('shows an empty guest list without inviting the user to create a task', async () => {
    vi.mocked(request).mockResolvedValue({ ...page, items: [], total: 0 });
    wrapper = mountTasks('guest');
    await flushPromises();

    expect(wrapper.get('#empty-heading').text()).toBe('Пока нет задач');
    expect(wrapper.find('.empty-state button').exists()).toBe(false);
    expect(wrapper.find('.page-heading button').exists()).toBe(false);
  });

  it.each(['guest', 'foreign'] as const)('does not send mutation requests for %s', async (role) => {
    vi.mocked(request).mockResolvedValue(page);
    const view = mountTasks(role);
    wrapper = view;
    await flushPromises();
    vi.mocked(request).mockClear();

    view.vm.createTask();
    await view.vm.editTask(task);
    await view.vm.saveTask({ title: 'Новая задача' });
    await view.vm.toggleTask(task, true);
    view.vm.confirmDelete(task);
    await view.vm.deleteTask();

    expect(request).not.toHaveBeenCalled();
    expect(view.findComponent(TaskForm).exists()).toBe(false);
    expect(view.vm.deletingTask).toBeNull();
  });

  it('does not allow a manager to open a delete confirmation', async () => {
    vi.mocked(request).mockResolvedValue(page);
    const view = mountTasks('manager');
    wrapper = view;
    await flushPromises();
    vi.mocked(request).mockClear();

    view.vm.confirmDelete(task);
    await view.vm.deleteTask();

    expect(view.vm.deletingTask).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('lets an admin confirm deletion and refresh the task list', async () => {
    vi.mocked(request)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...page, items: [], total: 0 });
    const view = mountTasks('admin');
    wrapper = view;
    await flushPromises();

    await view.get('[aria-label="Удалить задачу: Исходная задача"]').trigger('click');
    await view.get('.delete-actions .danger').trigger('click');
    await flushPromises();

    expect(request).toHaveBeenNthCalledWith(2, '/api/tasks/task-1', { method: 'DELETE' });
    expect(request).toHaveBeenNthCalledWith(3, '/api/tasks?page=1&limit=10');
    expect(view.vm.deletingTask).toBeNull();
    expect(view.text()).toContain('Задача удалена.');
  });
});
