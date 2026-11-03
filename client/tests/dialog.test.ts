import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppDialog from '../src/components/ui/AppDialog.vue';

let wrapper: VueWrapper | undefined;
const showModal = vi.fn();
const close = vi.fn();

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe('modal dialog', () => {
  it('opens a labelled native modal and closes it when removed', () => {
    wrapper = mount(AppDialog, { props: { title: 'Редактирование задачи', headingId: 'edit-task' } });

    expect(showModal).toHaveBeenCalledOnce();
    expect(wrapper.get('dialog').attributes('aria-labelledby')).toBe('edit-task');
    expect(wrapper.get('#edit-task').text()).toBe('Редактирование задачи');
    wrapper.unmount();
    wrapper = undefined;
    expect(close).toHaveBeenCalledOnce();
  });

  it('routes Escape through the component close event', async () => {
    wrapper = mount(AppDialog, { props: { title: 'Задача', headingId: 'task-title' } });

    await wrapper.get('dialog').trigger('cancel');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('keeps an in-flight mutation open on Escape and disables the close button', async () => {
    wrapper = mount(AppDialog, { props: { title: 'Задача', headingId: 'task-title', busy: true } });

    await wrapper.get('dialog').trigger('cancel');
    await wrapper.get('button').trigger('click');

    expect(wrapper.get('button').attributes()).toHaveProperty('disabled');
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('closes only for a click outside the dialog content bounds', async () => {
    wrapper = mount(AppDialog, {
      props: { title: 'Задача', headingId: 'task-title' },
      slots: { default: '<p>Содержимое</p>' },
    });
    vi.spyOn(wrapper.get('dialog').element, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 110, width: 200, height: 100,
      toJSON: () => ({}),
    });

    await wrapper.get('p').trigger('click', { clientX: 20, clientY: 20 });
    await wrapper.get('dialog').trigger('click', { clientX: 20, clientY: 20 });
    expect(wrapper.emitted('close')).toBeUndefined();

    await wrapper.get('dialog').trigger('click', { clientX: 5, clientY: 5 });
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
