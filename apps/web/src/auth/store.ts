import { defineStore } from "pinia";
import { createAuthSession } from "./session";

export const useAuthStore = defineStore("auth", createAuthSession);
