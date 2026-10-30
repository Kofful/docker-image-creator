import { createApp } from "vue";
import App from "./App.vue";
import { createPinia } from "pinia";
import { createAppRouter } from "./router";
import "./style.css";

const pinia = createPinia();
createApp(App).use(pinia).use(createAppRouter(pinia)).mount("#app");
