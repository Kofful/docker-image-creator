import { createRouter, createWebHistory, type RouterHistory } from "vue-router";
import type { Pinia } from "pinia";
import { useAuthStore } from "./auth/store";
import AuthPage from "./views/AuthPage.vue";
import AccountPage from "./views/AccountPage.vue";

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
    ],
  });
  router.beforeEach((to) => {
    const auth = useAuthStore(pinia);
    if (to.meta.requiresAuth && !auth.hasSession) return "/login";
    if (to.meta.guest && auth.hasSession) return "/account";
  });
  router.afterEach((to) => {
    document.title = `${to.path === "/register" ? "Create account" : to.path === "/login" ? "Log in" : "Account"} · Docker Image Creator`;
  });
  return router;
}
