<template>
  <main class="job-list">
    <p class="eyebrow">Сбор вакансий</p>
    <h1>Вакансии</h1>
    <p class="subtitle">Здесь появятся вакансии, найденные модулями источников.</p>
    <section class="message" aria-label="Состояние сбора">Сбор ещё не запускался.</section>
  </main>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({});
</script>

<style lang="scss" scoped>
.job-list {
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
    max-width: 650px;
    margin-top: 30px;
  }
}
</style>
