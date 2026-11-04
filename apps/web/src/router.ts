import { createRouter, createWebHistory, type RouterHistory } from "vue-router";
import type { Pinia } from "pinia";
import { useAuthStore } from "./auth/store";
import AuthPage from "./views/AuthPage.vue";
import AccountPage from "./views/AccountPage.vue";
import ConfigsPage from "./views/ConfigsPage.vue";
import NewConfigPage from "./views/NewConfigPage.vue";
import ConfigPage from "./views/ConfigPage.vue";

export function createAppRouter(
  pinia: Pinia,
  history: RouterHistory = createWebHistory(),
) {
  const router = createRouter({
    history,
    routes: [
      { path: "/", redirect: "/account" },
      {
        path: "/login",
        component: AuthPage,
        props: { mode: "login" },
        meta: { guest: true },
      },
      {
        path: "/register",
        component: AuthPage,
        props: { mode: "register" },
        meta: { guest: true },
      },
      {
        path: "/account",
        component: AccountPage,
        meta: { requiresAuth: true },
      },
      { path: "/:pathMatch(.*)*", redirect: "/account" },
      {
        path: "/configs",
        component: ConfigsPage,
        meta: { requiresAuth: true },
      },
      {
        path: "/configs/new",
        component: NewConfigPage,
        meta: { requiresAuth: true },
      },
      {
        path: "/configs/:id/console/:service",
        component: () => import("./views/TerminalPage.vue"),
        meta: { requiresAuth: true, terminal: true },
      },
      {
        path: "/configs/:id",
        component: ConfigPage,
        meta: { requiresAuth: true, terminalLanding: true },
      },
    ],
  });
  router.beforeEach((to) => {
    const auth = useAuthStore(pinia);
    const endedTerminal =
      to.meta.terminalLanding && to.query.terminal === "authorization_ended";
    if (to.meta.requiresAuth && !auth.hasSession && !endedTerminal)
      return "/login";
    if (to.meta.guest && auth.hasSession) return "/account";
  });
  router.afterEach((to) => {
    document.title = `${to.path.startsWith("/configs") ? "Configurations" : to.path === "/register" ? "Create account" : to.path === "/login" ? "Log in" : "Account"} · Docker Image Creator`;
  });
  return router;
}
