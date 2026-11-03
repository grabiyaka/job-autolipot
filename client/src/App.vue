<template>
  <RouterView v-if="!authenticated" />
  <div v-else class="workspace">
    <aside class="sidebar">
      <RouterLink class="brand" to="/tasks" aria-label="JWX — задачи"><span>j.</span> JWX <small>workspace</small></RouterLink>
      <p class="eyebrow navigation-label">Рабочее пространство</p>
      <nav aria-label="Основная навигация">
        <RouterLink to="/tasks"><AppIcon name="tasks" /> Задачи</RouterLink>
        <RouterLink to="/profile"><AppIcon name="user" /> Мой профиль</RouterLink>
      </nav>
      <footer>
        <span class="avatar">{{ initials }}</span>
        <p><strong>{{ user?.name }}</strong><small>{{ roleLabel }}</small></p>
        <button class="button quiet icon" type="button" aria-label="Выйти из аккаунта" :disabled="leaving" @click="signOut"><AppIcon name="logout" /></button>
      </footer>
    </aside>
    <section class="content">
      <header class="topbar">
        <p>Рабочее пространство <AppIcon name="chevron" /> <strong>{{ $route.meta.title }}</strong></p>
        <span class="session-label"><i /> Вы в системе</span>
      </header>
      <p v-if="logoutError" class="message error" role="alert">{{ logoutError }}</p>
      <RouterView />
      <footer class="page-footer"><span>JWX workspace</span><span>Всё необходимое для работы.</span></footer>
    </section>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import AppIcon from '@/components/ui/AppIcon.vue';
import { useUserStore } from '@/store/user';
import { errorMessage } from '@/mixin/fetch';

export default defineComponent({
  components: { AppIcon },
  data: () => ({ leaving: false, logoutError: '' }),
  computed: {
    ...mapState(useUserStore, ['user', 'authenticated', 'roleLabel']),
    initials(): string {
      return this.user?.name.split(' ').slice(0, 2).map((part) => part[0]).join('').toUpperCase() ?? 'J';
    },
  },
  methods: {
    ...mapActions(useUserStore, ['logout']),
    async signOut() {
      this.leaving = true;
      this.logoutError = '';
      try {
        await this.logout();
        await this.$router.replace('/login');
      } catch (error) {
        this.logoutError = errorMessage(error);
      } finally {
        this.leaving = false;
      }
    },
  },
});
</script>

<style lang="scss" scoped>
.workspace {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  min-height: 100dvh;

  @include responsive(850px) {
    grid-template-columns: 210px minmax(0, 1fr);
  }

  @include responsive(650px) {
    display: flex;
    flex-direction: column;
  }

  .sidebar {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    padding: 35px 21px 20px;
    border-right: 1px solid $line;
    background: white;

    @include responsive(650px) {
      position: static;
      height: auto;
      padding: 18px 20px 12px;
      border-right: 0;
      border-bottom: 1px solid $line;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-left: 6px;
      font-size: 20px;
      font-weight: 750;
      letter-spacing: -0.05em;

      span {
        display: grid;
        place-items: center;
        width: 35px;
        height: 35px;
        border-radius: 10px;
        background: $primary;
        color: white;
        font-size: 27px;
        line-height: 1;
      }

      small {
        align-self: flex-end;
        margin-bottom: 4px;
        color: $muted;
        font-size: 11px;
        font-weight: 400;
        letter-spacing: 0;
      }
    }

    .navigation-label {
      margin: 47px 10px 15px;
      font-size: 9px;

      @include responsive(650px) {
        display: none;
      }
    }

    nav {
      display: flex;
      flex-direction: column;
      gap: 7px;

      @include responsive(650px) {
        flex-direction: row;
        margin-top: 17px;
      }

      a {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 8px;
        color: $muted;
        font-weight: 550;

        &.router-link-active {
          color: $primary;
          background: $primary-soft;
        }
      }
    }

    footer {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: auto;
      padding-top: 20px;
      border-top: 1px solid $line;

      @include responsive(650px) {
        display: none;
      }

      .avatar {
        display: grid;
        place-items: center;
        width: 35px;
        height: 35px;
        flex-shrink: 0;
        border-radius: 50%;
        background: $primary-soft;
        color: $primary;
        font-size: 11px;
        font-weight: 700;
      }

      p {
        min-width: 0;
        flex: 1;

        strong, small {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        strong {
          font-size: 12px;
        }

        small {
          margin-top: 2px;
          color: $muted;
          font-size: 10px;
        }
      }
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-width: 0;

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      min-height: 82px;
      padding: 20px 42px;
      border-bottom: 1px solid $line;
      background: white;
      font-size: 12px;

      @include responsive(850px) {
        padding-inline: 24px;
      }

      @include responsive(650px) {
        min-height: 55px;
        padding: 15px 20px;
      }

      p {
        display: flex;
        align-items: center;
        gap: 10px;
        color: $muted;

        strong {
          color: $ink;
          font-weight: 500;
        }

        .app-icon {
          width: 12px;
          height: 12px;
        }
      }

      .session-label {
        display: flex;
        align-items: center;
        gap: 7px;
        color: $muted;
        white-space: nowrap;

        @include responsive(480px) {
          display: none;
        }

        i {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: $success;
        }
      }
    }

    > .message {
      margin: 20px 24px 0;
    }

    .page-footer {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin-top: auto;
      padding: 23px 42px;
      color: $muted;
      font-size: 11px;

      @include responsive(850px) {
        padding-inline: 24px;
      }

      @include responsive(480px) {
        span:last-child {
          display: none;
        }
      }
    }
  }
}
</style>
