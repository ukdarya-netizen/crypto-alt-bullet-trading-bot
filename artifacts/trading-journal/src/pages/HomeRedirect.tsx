import { Show, useClerk } from "@clerk/react";
import { Redirect } from "wouter";
import Landing from "@/pages/Landing";

export default function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/journal/overview" />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}
