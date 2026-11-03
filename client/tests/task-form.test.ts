import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import TaskForm from '../src/components/tasks/TaskForm.vue';
import type { Task } from '../src/components/tasks/TaskTypes';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

function taskFixture(): Task {
  return {
    id: 'task-1', title: 'Подготовить макеты', description: 'Черновик', status: 'IN_PROGRESS',
    priority: 3, dueAt: '2030-04-05T12:34:56.678Z', tags: ['дизайн', 'обсудить'], completed: false,
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-02T00:00:00.000Z',
  };
}

describe('task editing', () => {
  it('creates a complete payload, trimming input and clearing optional values with null', async () => {
    wrapper = mount(TaskForm);

    await wrapper.get('[name="title"]').setValue('  Подготовить встречу  ');
    await wrapper.get('[name="description"]').setValue('   ');
    await wrapper.get('[name="tags"]').setValue(' планирование, , команда,планирование , ');
    await wrapper.get('[name="priority"]').setValue('7');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')).toEqual([[{
      title: 'Подготовить встречу', description: null, status: 'OPEN', priority: 7,
      dueAt: null, tags: ['планирование', 'команда'], completed: false,
    }]]);
  });

  it('does not mutate the original task when a draft is edited or cancelled', async () => {
    const task = taskFixture();
    const original = structuredClone(task);
    Object.freeze(task.tags);
    Object.freeze(task);
    wrapper = mount(TaskForm, { props: { task } });

    await wrapper.get('[name="title"]').setValue('Новое название');
    await wrapper.get('[name="tags"]').setValue('новая метка');
    await wrapper.get('footer button[type="button"]').trigger('click');

    expect(task).toEqual(original);
    expect(wrapper.emitted('save')).toBeUndefined();
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('preserves existing tags with commas and duplicates when that field is not edited', async () => {
    const task = { ...taskFixture(), tags: ['UI, UX', 'повтор', 'повтор'] };
    wrapper = mount(TaskForm, { props: { task } });

    await wrapper.get('[name="title"]').setValue('Обновить только название');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({
      title: 'Обновить только название', tags: ['UI, UX', 'повтор', 'повтор'],
    });
  });

  it.each(['2030-04-05T12:34:56.678Z', '2030-10-27T01:30:56.678Z'])(
    'preserves an unchanged due date exactly, including precision and DST offsets: %s', async (dueAt) => {
      const task = { ...taskFixture(), dueAt };
      wrapper = mount(TaskForm, { props: { task } });

      await wrapper.get('[name="title"]').setValue('Уточнённое название');
      await wrapper.get('form').trigger('submit');

      expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ title: 'Уточнённое название', dueAt: task.dueAt });
    },
  );

  it('converts a newly entered local due date to the API UTC format', async () => {
    const enteredDate = '2030-10-05T14:15';
    wrapper = mount(TaskForm, { props: { task: taskFixture() } });

    await wrapper.get('[name="dueAt"]').setValue(enteredDate);
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ dueAt: new Date(enteredDate).toISOString() });
  });

  it('explicitly clears an existing description and due date', async () => {
    wrapper = mount(TaskForm, { props: { task: taskFixture() } });

    await wrapper.get('[name="description"]').setValue('');
    await wrapper.get('[name="dueAt"]').setValue('');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ description: null, dueAt: null });
  });

  it('does not submit a blank title even if form submission is triggered directly', async () => {
    wrapper = mount(TaskForm);

    await wrapper.get('[name="title"]').setValue('   ');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(wrapper.get('button[type="submit"]').attributes()).toHaveProperty('disabled');
  });

  it('prevents duplicate saves while an earlier request is in flight', async () => {
    wrapper = mount(TaskForm, { props: { task: taskFixture(), saving: true } });

    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(wrapper.get('button[type="submit"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[name="title"]').attributes()).toHaveProperty('disabled');
  });
});
