<template>
  <main class="login-page">
    <section class="introduction" aria-label="JWX workspace">
      <a class="brand" href="/">jwx<span>workspace</span></a>
      <div class="welcome">
        <p class="eyebrow">Место для ваших идей</p>
        <h1>Большие планы.<br /> Понятные шаги.</h1>
        <p>Соберите задачи в одном месте.<br />Сосредоточьтесь на том, что важно.</p>
        <div class="illustration" aria-hidden="true">
          <article class="preview-card"><span class="preview-icon"><AppIcon name="tasks" /></span><strong>От идеи — к результату</strong><span class="preview-completed"><AppIcon name="check" /> Первый шаг сделан</span></article>
          <span class="floating-check"><AppIcon name="check" /></span>
        </div>
      </div>
      <footer>Пространство, в котором всё складывается.</footer>
    </section>
    <section class="login-panel">
      <form class="login-form" @submit.prevent="submit">
        <span class="login-symbol"><AppIcon name="lock" /></span>
        <p class="eyebrow">С возвращением</p>
        <h2>Войдите в пространство</h2>
        <p class="subtitle">Ваши задачи уже здесь. Продолжим?</p>
        <p v-if="error" class="message error" role="alert">{{ error }}</p>
        <p v-else-if="$route.query.expired" class="message" role="status">Сессия завершилась. Войдите ещё раз.</p>
        <p v-else-if="$route.query.unavailable" class="message error" role="alert">Сервер временно недоступен. Попробуйте войти ещё раз.</p>
        <label class="field">Электронная почта<input v-model.trim="email" type="email" name="email" autocomplete="username" placeholder="you@company.com" required :disabled="pending" /></label>
        <label class="field">Пароль<input v-model="password" type="password" name="password" autocomplete="current-password" placeholder="Введите пароль" required :disabled="pending" /></label>
        <button class="button primary" type="submit" :disabled="pending || !email || !password">{{ pending ? 'Входим…' : 'Войти' }} <AppIcon name="arrow" /></button>
        <p class="help">Нет доступа? Обратитесь к администратору<br />вашего рабочего пространства.</p>
      </form>
      <footer><AppIcon name="lock" /> Защищённое рабочее пространство</footer>
    </section>
  </main>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions } from 'pinia';
import { useUserStore } from '@/store/user';
import { ApiError, errorMessage } from '@/mixin/fetch';
import { safeRedirect } from '@/router';
import AppIcon from '@/components/ui/AppIcon.vue';

export default defineComponent({
  components: { AppIcon },
  data: () => ({ email: '', password: '', pending: false, error: '' }),
  methods: {
    ...mapActions(useUserStore, ['login']),
    async submit() {
      if (this.pending) return;
      this.pending = true;
      this.error = '';
      try {
        await this.login(this.email, this.password);
        this.password = '';
        await this.$router.replace(safeRedirect(this.$route.query.redirect));
      } catch (error) {
        this.error = error instanceof ApiError && error.status === 401
          ? 'Неверная почта или пароль. Проверьте данные и попробуйте снова.'
          : errorMessage(error);
      } finally {
        this.pending = false;
      }
    },
  },
});
</script>

<style lang="scss" scoped>
.login-page {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 100dvh;
  background: white;

  @include responsive(850px) {
    grid-template-columns: 0.9fr 1.1fr;
  }

  @include responsive(650px) {
    display: flex;
    flex-direction: column;
  }

  .introduction {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 42px 11%;
    background: $primary-soft;

    @include responsive(850px) {
      padding-inline: 10%;
    }

    @include responsive(650px) {
      padding: 24px;
    }

    .brand {
      display: flex;
      align-items: baseline;
      gap: 10px;
      color: $primary;
      font-size: 37px;
      font-weight: 800;
      letter-spacing: -0.09em;

      span {
        color: $muted;
        font-size: 13px;
        font-weight: 400;
        letter-spacing: 0;
      }
    }

    .welcome {
      margin-block: auto;
      padding-top: 60px;

      @include responsive(650px) {
        padding-top: 28px;
      }

      .eyebrow {
        margin-bottom: 22px;
        color: $primary;

        @include responsive(650px) {
          display: none;
        }
      }

      h1 {
        font-size: clamp(32px, 3.45vw, 52px);
        font-weight: 650;
        letter-spacing: -0.06em;

        @include responsive(650px) {
          font-size: 28px;

          br {
            display: none;
          }
        }
      }

      > p:not(.eyebrow) {
        margin-top: 24px;
        color: $muted;
        font-size: 15px;
        line-height: 1.8;

        @include responsive(650px) {
          display: none;
        }
      }
    }

    .illustration {
      position: relative;
      display: grid;
      place-items: center;
      height: 330px;
      margin-top: 12px;

      @include responsive(650px) {
        display: none;
      }

      &::before, &::after {
        position: absolute;
        content: '';
        width: 310px;
        height: 230px;
        border: 1px solid $orbit-line;
        border-radius: 50%;
        transform: rotate(-22deg);

      }

      &::after {
        width: 370px;
        height: 270px;
        transform: rotate(25deg);
      }

      .preview-card {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 266px;
        padding: 24px;
        border: 1px solid $glass-line;
        border-radius: 16px;
        background: $glass;
        box-shadow: $shadow;
        transform: rotate(-6deg);

        .preview-icon {
          display: grid;
          place-items: center;
          width: 39px;
          height: 39px;
          margin-bottom: 15px;
          border-radius: 10px;
          background: $primary-soft;
          color: $primary;
        }

        strong {
          margin-bottom: 17px;
          font-size: 13px;
        }

        .preview-completed {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-top: 13px;
          color: $success;
          font-size: 11px;

          .app-icon {
            width: 16px;
            height: 16px;
          }
        }
      }

      .floating-check {
        position: absolute;
        right: 3%;
        bottom: 65px;
        display: grid;
        place-items: center;
        width: 49px;
        height: 49px;
        border: 5px solid $primary-soft;
        border-radius: 15px;
        background: $primary;
        color: white;
        transform: rotate(12deg);
      }
    }

    footer {
      color: $muted;
      font-size: 11px;

      @include responsive(650px) {
        display: none;
      }
    }
  }

  .login-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 0;
    padding: 60px 40px 32px;

    @include responsive(650px) {
      flex: 1;
      padding: 40px 24px 24px;
    }

    .login-form {
      display: flex;
      flex-direction: column;
      gap: 22px;
      width: min(100%, 350px);
      margin-block: auto;

      .login-symbol {
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        margin-bottom: 5px;
        border: 1px solid $line;
        border-radius: 12px;
        color: $primary;
      }

      .eyebrow {
        margin-bottom: -10px;
      }

      h2 {
        font-size: 28px;
        font-weight: 650;
        letter-spacing: -0.045em;
      }

      .subtitle {
        margin-top: -12px;
        margin-bottom: 8px;
        color: $muted;
        font-size: 13px;
      }

      .button {
        justify-content: space-between;
        margin-top: 3px;
      }

      .help {
        margin-top: 2px;
        color: $muted;
        font-size: 11px;
        line-height: 1.8;
        text-align: center;
      }
    }

    footer {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-top: 40px;
      color: $muted;
      font-size: 10px;

      .app-icon {
        width: 12px;
        height: 12px;
      }
    }
  }
}
</style>
