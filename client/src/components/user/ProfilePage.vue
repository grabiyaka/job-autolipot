<template>
  <main class="profile-page">
    <p class="eyebrow">Ваш аккаунт</p>
    <h1>Мой профиль</h1>
    <p class="subtitle">Данные вашего рабочего пространства.</p>
    <section aria-label="Данные профиля">
      <span class="profile-icon"><AppIcon name="user" /></span>
      <h2>{{ user?.name }}</h2>
      <dl><dt>Электронная почта</dt><dd>{{ user?.email }}</dd><dt>Уровень доступа</dt><dd>{{ roleLabel }}</dd></dl>
      <p class="message">Для изменения данных или уровня доступа обратитесь к администратору.</p>
      <p v-if="error" class="message error" role="alert">{{ error }}</p>
      <button class="button" type="button" :disabled="pending" @click="signOut"><AppIcon name="logout" /> {{ pending ? 'Выходим…' : 'Выйти из аккаунта' }}</button>
    </section>
  </main>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { useUserStore } from '@/store/user';
import { errorMessage } from '@/mixin/fetch';
import AppIcon from '@/components/ui/AppIcon.vue';

export default defineComponent({
  components: { AppIcon },
  data: () => ({ error: '', pending: false }),
  computed: { ...mapState(useUserStore, ['user', 'roleLabel']) },
  methods: {
    ...mapActions(useUserStore, ['logout']),
    async signOut() {
      this.pending = true;
      this.error = '';
      try {
        await this.logout();
        await this.$router.replace('/login');
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.pending = false;
      }
    },
  },
});
</script>

<style lang="scss" scoped>
.profile-page {
  padding: 44px 42px;

  @include responsive(850px) {
    padding: 30px 24px;
  }

  h1 {
    margin-top: 10px;
    font-size: 30px;
    letter-spacing: -0.04em;
  }

  .subtitle {
    margin-top: 10px;
    color: $muted;
  }

  section {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 24px;
    max-width: 650px;
    margin-top: 30px;
    padding: 30px;
    border: 1px solid $line;
    border-radius: 14px;
    background: white;

    @include responsive(480px) {
      padding: 22px;
    }

    .profile-icon {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 16px;
      color: $primary;
      background: $primary-soft;
    }

    h2 {
      font-size: 21px;
    }

    dl {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px 30px;
      margin: 0;

      @include responsive(480px) {
        grid-template-columns: 1fr;
        gap: 7px;
      }

      dt {
        color: $muted;
      }

      dd {
        margin: 0;
        overflow-wrap: anywhere;
        font-weight: 500;

        @include responsive(480px) {
          margin-bottom: 12px;
        }
      }
    }

    .message {
      font-size: 12px;
    }
  }
}
</style>
