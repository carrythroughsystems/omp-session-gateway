# Release status

<!-- release-generate:current:start -->
## v0.9.0 preparation — not yet qualified or published

**Prepared:** 2026-10-25. This release uses stock OMP v18.12.5 as its engineering baseline. The 44 changelog entries below record the changes since v0.8.0. Historical receipts do not qualify these bytes.

- Planned qualification: Debian 13 x86-64; macOS 27.0 (26A428) arm64 in a Virtualization.framework guest (VirtualMac2,1, ADR-033); a disposable Windows Server 2025 host (the Administrator lifecycle and a fresh standard-user install); Chrome on the physical Pixel 10 Pro, including its background-Push lane; and real iPhone, iPad, and Galaxy devices in TestingBot's cloud. Every lane must pass against these exact signed bytes before stable promotion; the plan is not evidence.

Published v0.8.0 remains the predecessor and current stable. The planned candidate tag is `v0.9.0-prealpha.3`; no qualification or publication is claimed. The stable lock stays unchanged until approval.
<!-- release-generate:current:end -->

## Mainline v0.8.0 — published stable

**Updated:** 2026-10-23. [v0.8.0](https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.8.0) was published at **2026-10-23T11:34:34Z** and is GitHub Latest. [Signed release workflow](https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/39946829431).

**Stable source:** `f2110adcc7e24237a94bb4d12e8406683e94324f`.<br>
**Stable archive SHA-256:** `40dcf35b116f2bde95e8ccabb6e008b52f633e975e8a6a39a0a4eaecba3ddae0`.

**Candidate:** [v0.8.0-prealpha.6](https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.8.0-prealpha.6).<br>
**Source:** `f35b02c1a97456c778a359366f73df4beb436fb9`.<br>
**Archive SHA-256:** `3ed73a967dc552da70d678ec5135430b6dc140992f3dcaf7d473bce7e2e7b47d`.<br>
**Predecessor:** published `v0.7.7`.

This release uses stock OMP v18.12.5 as its engineering baseline. The 39 changelog entries below record the changes since v0.7.7. Historical receipts do not qualify these bytes.

### Candidate evidence

Schema 3 campaign 2026-10-23T10:10:57.017Z–2026-10-23T11:03:10.289Z; orchestrator `f35b02c1a97456c778a359366f73df4beb436fb9`.

| Lane | Attempts | Evidence |
|---|---|---|
| artifacts | 1 | Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; v0.7.7 verified the same way. |
| debian | 1 | Run 39937344468 succeeded (https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/39937344468); OS/kernel versions and migration counts are not exported. |
| macos | 1 | VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon a9dda5e6640b173279d738c0d13374fcc5daa409d7167ce9ff54ea56bf5afb30. |
| ompPublication | 1 | Stock OMP v18.12.5; generation 1; publication, View/Control, new-generation/fork/resume and revocation. |
| android | 1 | Pixel 8 Pro, Android 17 build CP3A.261005.005, Chrome 155.0.8059.84; same-page unlock 7066 ms, Airplane 3597 ms, Doze 117 ms; 7/7 detectable; clean. |
| androidPush | 1 | Android 17, Chrome 155.0.8059.84, installed WebAPK; force-stop delivered_while_force_stopped, Doze delivered_after_doze_exit; outcomes are observed variants, not delivery guarantees. |
| androidPushCleanup | 1 | Device, browser and fixture restored. |
| deviceCloud | 1 | TestingBot, tunnel 4.9: iPhone 17 Pro (26.5, safari 26.5); TestingBot, tunnel 4.9: iPad (9th generation) (26.6, safari 26.6); TestingBot, tunnel 4.9: Galaxy S26 (16.0.0, chrome 145.0.7632.159). Home Screen alerts were proven only on the TestingBot iPhone and do not qualify lock-screen presentation. |
| deviceCloudCleanup | 1 | Restored. |
| relay | 1 | 1800 seconds, 2026-10-23T10:24:08.150Z–2026-10-23T10:54:08.165Z; 2 transitions, final phase live. Eight-hour endurance is not claimed. |
| cleanup | 1 | Zero gateway processes, listeners and live OMP hosts. |
| windows | 1 | Windows x86-64 build 26100; 4 CPUs, 8186 MiB; Administrator upgrade/rollback from v0.7.7 and fresh standard-account lifecycle; interactive logon, not unattended boot. |
| windowsCleanup | 1 | Zero instances and firewalls; tailnet node deleted and access vault removed. |

<details>
<summary>Public measured results (booleans and numbers; private identities omitted)</summary>

```json
{
  "artifacts": {
    "startedAt": "2026-10-23T10:11:05.995Z",
    "completedAt": "2026-10-23T10:11:36.644Z",
    "measurements": {
      "signedTag": true,
      "predecessor": {
        "signedTag": true
      }
    }
  },
  "debian": {
    "startedAt": "2026-10-23T10:11:36.646Z",
    "completedAt": "2026-10-23T10:21:39.361Z",
    "measurements": {
      "runId": 39937344468
    }
  },
  "macos": {
    "startedAt": "2026-10-23T10:21:39.365Z",
    "completedAt": "2026-10-23T10:23:58.334Z",
    "measurements": {
      "guestRebootChanged": true,
      "consoleLogin": true,
      "readinessPreserved": true
    }
  },
  "ompPublication": {
    "startedAt": "2026-10-23T10:23:58.531Z",
    "completedAt": "2026-10-23T10:57:48.185Z",
    "measurements": {
      "generation": 1,
      "published": true,
      "lifecycle": {
        "newGeneration": {
          "sameInstance": true,
          "generationDelta": 1,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "fork": {
          "sameInstance": true,
          "generationDelta": 1,
          "syntheticMessages": 2,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "resumed": {
          "newInstance": true,
          "generation": 1,
          "sameLabel": true,
          "liveLaunches": 2,
          "noStore": true,
          "revocations": 2
        }
      },
      "revoked": true
    }
  },
  "android": {
    "startedAt": "2026-10-23T10:24:06.902Z",
    "completedAt": "2026-10-23T10:27:09.128Z",
    "measurements": {
      "unlockMs": 7066,
      "airplaneRecoveredMs": 3597,
      "dozeRecoveredMs": 117,
      "collaboration": {
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true
      }
    }
  },
  "androidPush": {
    "startedAt": "2026-10-23T10:24:06.902Z",
    "completedAt": "2026-10-23T10:57:05.252Z",
    "measurements": {
      "passed": true,
      "platform": {
        "webApk": true,
        "dndOff": true
      },
      "phases": {
        "subscription_ready": {
          "enabled": true,
          "dndOff": true,
          "phaseElapsedMs": 13060
        },
        "private_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1181,
          "dndOff": true,
          "phaseElapsedMs": 38077
        },
        "session_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 2183,
          "dndOff": true,
          "phaseElapsedMs": 60132
        },
        "preview_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1420,
          "dndOff": true,
          "phaseElapsedMs": 48891
        },
        "attention_tap_verified": {
          "control": true,
          "revalidated": true,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 50444
        },
        "activity_stop_verified": {
          "knownBusyPolls": 2,
          "viewOnly": true,
          "dndOff": true,
          "phaseElapsedMs": 58243
        },
        "stale_generation_verified": {
          "sameInstance": true,
          "generationIncrement": 1,
          "launches": 0,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 70610
        },
        "clear_verified": {
          "authoritativeClear": true,
          "freshRequestRetained": true,
          "dndOff": true,
          "phaseElapsedMs": 70978
        },
        "triage_verified": {
          "fifo": true,
          "holdAdvanced": true,
          "heldNotificationClosed": true,
          "pendingRetained": true,
          "requeued": true,
          "allHeld": true,
          "staleHoldReleased": true,
          "undoRestored": true,
          "undoExpired": true,
          "attentionRestored": true,
          "shownAll": true,
          "mutations": 0,
          "dndOff": true,
          "phaseElapsedMs": 139508
        },
        "stale_taps_verified": {
          "resolved": true,
          "rearmed": true,
          "replaced": true,
          "expired": true,
          "launches": 0,
          "scrubbed": true,
          "replayed": true,
          "dndOff": true,
          "phaseElapsedMs": 235567
        },
        "force_stop_verified": {
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 95372
        },
        "permission_verified": {
          "suppressed": true,
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 109714
        },
        "lock_resume_verified": {
          "lockedDelivery": true,
          "resumed": true,
          "dndOff": true,
          "phaseElapsedMs": 30318
        },
        "network_verified": {
          "wifiDelivery": true,
          "cellularDelivery": true,
          "airplaneSuppressed": true,
          "recovered": true,
          "dndOff": true,
          "phaseElapsedMs": 160080
        },
        "doze_verified": {
          "dndOff": true,
          "phaseElapsedMs": 89006
        },
        "forbidden_sinks_verified": {
          "detectable": true,
          "clean": true,
          "sinks": 10,
          "findings": 0,
          "gatewayLogsDiscarded": true,
          "dndOff": true,
          "phaseElapsedMs": 13086
        },
        "evidence_complete": {
          "passed": true,
          "dndOff": true,
          "phaseElapsedMs": 147
        }
      },
      "cleanup": {
        "restored": true,
        "deviceRestored": true,
        "browserRestored": true,
        "fixtureStopped": true
      }
    }
  },
  "androidPushCleanup": {
    "startedAt": "2026-10-23T10:57:05.255Z",
    "completedAt": "2026-10-23T10:57:05.889Z",
    "measurements": {
      "restored": true
    }
  },
  "deviceCloud": {
    "startedAt": "2026-10-23T10:24:06.902Z",
    "completedAt": "2026-10-23T10:35:15.853Z",
    "measurements": {
      "passed": true,
      "targets": {
        "iphone": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "homeScreenApp": true,
          "alertsEnabled": true,
          "subscriptionOmitsExpirationTime": true,
          "deliveredMs": 2215,
          "tapOpenedControl": true,
          "tapUrlScrubbed": true,
          "alertsDisabled": true,
          "tunnelRefusals": 19,
          "elapsedMs": 178746
        },
        "ipad": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 14,
          "elapsedMs": 74529
        },
        "android": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 41,
          "elapsedMs": 26748
        }
      },
      "audit": {
        "records": 4,
        "recordsExposingLinks": 0,
        "recordsWithMedia": 0,
        "lingeringSignedArtifacts": 0,
        "testingbotRecords": 4,
        "browserstackRecords": 0,
        "dashboardReferences": 0
      }
    }
  },
  "deviceCloudCleanup": {
    "startedAt": "2026-10-23T10:35:15.855Z",
    "completedAt": "2026-10-23T10:35:17.042Z",
    "measurements": {
      "restored": true
    }
  },
  "relay": {
    "startedAt": "2026-10-23T10:24:06.902Z",
    "completedAt": "2026-10-23T10:54:08.172Z",
    "measurements": {
      "durationSeconds": 1800,
      "transitions": 2
    }
  },
  "cleanup": {
    "startedAt": "2026-10-23T10:57:48.189Z",
    "completedAt": "2026-10-23T10:57:53.991Z",
    "measurements": {
      "gatewayProcesses": 0,
      "gatewayListeners": 0,
      "liveOmpHosts": 0
    }
  },
  "windows": {
    "startedAt": "2026-10-23T10:11:36.646Z",
    "completedAt": "2026-10-23T11:02:43.332Z",
    "measurements": {
      "timings": {
        "firewall_created": 1163,
        "instance_created": 713,
        "transport_ready": 423953,
        "toolchain_staged": 640662,
        "predecessor_installed": 23246,
        "candidate_upgraded": 45976,
        "reboot_requested": 23862,
        "prelogin_verified": 145685,
        "postlogin_ready": 50034,
        "doctor_passed": 12483,
        "omp_published": 33401,
        "pixel_verified": 1340300,
        "omp_revoked": 15569,
        "readiness_rotated": 9828,
        "predecessor_restored": 12841,
        "candidate_restored": 12997,
        "candidate_uninstalled": 7843,
        "standard_user_prepared": 9007,
        "standard_tailnet_released": 6095,
        "standard_tailnet_joined": 3645,
        "standard_interactive_ready": 13956,
        "standard_candidate_installed": 21136,
        "standard_reboot_requested": 22237,
        "standard_prelogin_verified": 136804,
        "standard_postlogin_ready": 22675,
        "standard_doctor_passed": 8840,
        "standard_readiness_rotated": 10806,
        "standard_candidate_uninstalled": 9887,
        "evidence_complete": 0
      },
      "observations": {
        "windowsBuild": 26100,
        "cpus": 4,
        "memoryMiB": 8186,
        "transportStabilitySamples": 3,
        "transportStabilityDurationMs": 71336,
        "taggedNode": true,
        "tunMode": true,
        "funnelOff": true,
        "loopbackOnly": true,
        "configPreserved": true,
        "readinessPreserved": true,
        "restored": true,
        "doctorChecks": 18,
        "doctorTrue": 15,
        "doctorIdentityAllowed": false,
        "doctorPwa": false,
        "doctorSessionHealth": false,
        "doctorSecurityHeaders": true,
        "logonTrigger": true,
        "interactivePrincipal": true,
        "logonTriggerScoped": true,
        "preloginSamples": 3,
        "preloginDurationMs": 57316,
        "automaticStartMs": 50034,
        "namedPipe": true,
        "generation": 1,
        "viewStatus": 200,
        "controlStatus": 200,
        "staleViewStatus": 409,
        "staleControlStatus": 409,
        "noStore": true,
        "pixelIdentityAccepted": true,
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true,
        "revoked": true,
        "readinessChanged": true,
        "historySelected": true,
        "uninstalled": true,
        "standardUserNonAdmin": true,
        "standardUserNoSecurityPrivilege": true,
        "standardPreloginSamples": 3,
        "standardPreloginDurationMs": 50524,
        "standardAutomaticStartMs": 22675,
        "standardDoctorChecks": 18,
        "standardDoctorTrue": 15,
        "standardReadinessChanged": true,
        "standardUninstalled": true,
        "standardConfigPreserved": true,
        "standardReadinessPreserved": true
      },
      "doctor": {
        "true": 15,
        "total": 18
      }
    }
  },
  "windowsCleanup": {
    "startedAt": "2026-10-23T11:02:43.333Z",
    "completedAt": "2026-10-23T11:03:10.285Z",
    "measurements": {
      "instancesRemaining": 0,
      "firewallsRemaining": 0,
      "tailnetDeleted": true,
      "vaultRemoved": true
    }
  }
}
```

</details>

**Runtime equivalence gate:** the approval driver must compare a clean stable-channel build with the qualified candidate before merging. The receipt does not prove that later build comparison. Only release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json and schemas/stable-release.schema.json may differ.

### Published-byte Studio/Pixel verification

Recorded 2026-10-23. Published-byte smoke passed against the stable source and digest above. Stock OMP 18.12.5, binary SHA-256 `49c1fc544e893b0fa2218bc5a1222935e4dacf50147b289ce0582f86d2da4a66`; app asset `/assets/app.8826e18df747.js`.

```json
{
  "gateway": {
    "installed": true,
    "configPreserved": true,
    "doctorChecks": 18
  },
  "tailscaleServe": {
    "changed": false,
    "unrelatedMappingsPreserved": true
  },
  "android": {
    "viewReadOnly": true,
    "controlWritable": true,
    "capabilitySinksClean": true,
    "samePageRecovery": true,
    "installedWebApk": true
  },
  "leaveInstalled": {
    "gateway": true,
    "mainlineOmp": true,
    "webApk": true
  },
  "status": {
    "installed": true,
    "active": true,
    "ready": true,
    "diverged": false,
    "activeVersion": "0.8.0-b5a08a35d7fc",
    "serviceVersion": "0.8.0-b5a08a35d7fc"
  }
}
```

This smoke does not expand the candidate matrix or qualify bare-metal Mac, Windows, cloud browsers or background Push beyond their candidate lanes.

## v0.7.8 preparation — not yet qualified or published

**Prepared:** 2026-10-22. This release uses stock OMP v18.12.5 as its engineering baseline. The 28 changelog entries below record the changes since v0.7.7. Historical receipts do not qualify these bytes.

- Planned qualification: Debian 13 x86-64; macOS 27.0 (26A428) arm64 in a Virtualization.framework guest (VirtualMac2,1, ADR-033); a disposable Windows Server 2025 host (the Administrator lifecycle and a fresh standard-user install); Chrome on the physical Pixel 10 Pro, including its background-Push lane; and real iPhone, iPad, and Galaxy devices in TestingBot's cloud. Every lane must pass against these exact signed bytes before stable promotion; the plan is not evidence.

Published v0.7.7 remains the predecessor and current stable. The planned candidate tag is `v0.7.8-prealpha.5`; no qualification or publication is claimed. The stable lock stays unchanged until approval.

## Mainline v0.7.7 — published stable

**Updated:** 2026-10-13. [v0.7.7](https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.7.7) was published at **2026-10-14T00:53:34Z** and is GitHub Latest. [Signed release workflow](https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/38492573699).

**Stable source:** `dabcf8984a12cb6203409805b5e385bc86771dce`.<br>
**Stable archive SHA-256:** `3210337a76c2137346b55fb81b32df98ff56bddc725b0e0d754a71009328528e`.

**Candidate:** [v0.7.7-prealpha.2](https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.7.7-prealpha.2).<br>
**Source:** `c8da6e07cc62b7b855c509037a827f082b564c69`.<br>
**Archive SHA-256:** `c63b893f163bc6ef1c77c42556645932dc76252b6fefce2b9dcbe21a91eb5705`.<br>
**Predecessor:** published `v0.7.6`.

This release uses stock OMP v18.10.2 as its engineering baseline. The 2 changelog entries below record the changes since v0.7.6. Historical receipts do not qualify these bytes.

### Candidate evidence

Schema 3 campaign 2026-10-13T23:35:19.538Z–2026-10-14T00:25:51.856Z; orchestrator `c8da6e07cc62b7b855c509037a827f082b564c69`.

| Lane | Attempts | Evidence |
|---|---|---|
| artifacts | 1 | Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; v0.7.6 verified the same way. |
| debian | 1 | Run 38485221785 succeeded (https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/38485221785); OS/kernel versions and migration counts are not exported. |
| macos | 1 | VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon b137c1ff0cb7eeb6b4f97ea10e7869779f8db33d9e9edb16d04c1250597b900d. |
| ompPublication | 1 | Stock OMP v18.10.2; generation 1; publication, View/Control, new-generation/fork/resume and revocation. |
| android | 1 | Pixel 8 Pro, Android 17 build CP3A.261005.005, Chrome 154.0.8037.126; same-page unlock 7052 ms, Airplane 3635 ms, Doze 133 ms; 7/7 detectable; clean. |
| androidPush | 1 | Android 17, Chrome 154.0.8037.126, installed WebAPK; force-stop delivered_while_force_stopped, Doze delivered_after_doze_exit; outcomes are observed variants, not delivery guarantees. |
| androidPushCleanup | 1 | Device, browser and fixture restored. |
| deviceCloud | 1 | TestingBot real devices, tunnel 4.9: iPhone 17 Pro (26.5, safari 26.5); iPad (9th generation) (26.6, safari 26.6); Galaxy S26 (16.0.0, chrome 145.0.7632.159). Home Screen alerts do not qualify lock-screen presentation. |
| deviceCloudCleanup | 1 | Restored. |
| relay | 1 | 1800 seconds, 2026-10-13T23:47:25.356Z–2026-10-14T00:17:25.370Z; 8 transitions, final phase live. Eight-hour endurance is not claimed. |
| cleanup | 1 | Zero gateway processes, listeners and live OMP hosts. |
| windows | 1 | Windows x86-64 build 26100; 4 CPUs, 8186 MiB; Administrator upgrade/rollback from v0.7.6 and fresh standard-account lifecycle; interactive logon, not unattended boot. |
| windowsCleanup | 1 | Zero instances and firewalls; tailnet node deleted and access vault removed. |

<details>
<summary>Public measured results (booleans and numbers; private identities omitted)</summary>

```json
{
  "artifacts": {
    "startedAt": "2026-10-13T23:35:27.304Z",
    "completedAt": "2026-10-13T23:35:56.234Z",
    "measurements": {
      "signedTag": true,
      "predecessor": {
        "signedTag": true
      }
    }
  },
  "debian": {
    "startedAt": "2026-10-13T23:35:56.236Z",
    "completedAt": "2026-10-13T23:44:45.863Z",
    "measurements": {
      "runId": 38485221785
    }
  },
  "macos": {
    "startedAt": "2026-10-13T23:44:45.866Z",
    "completedAt": "2026-10-13T23:47:11.487Z",
    "measurements": {
      "guestRebootChanged": true,
      "consoleLogin": true,
      "readinessPreserved": true
    }
  },
  "ompPublication": {
    "startedAt": "2026-10-13T23:47:11.703Z",
    "completedAt": "2026-10-14T00:20:54.509Z",
    "measurements": {
      "generation": 1,
      "published": true,
      "lifecycle": {
        "newGeneration": {
          "sameInstance": true,
          "generationDelta": 1,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "fork": {
          "sameInstance": true,
          "generationDelta": 1,
          "syntheticMessages": 2,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "resumed": {
          "newInstance": true,
          "generation": 1,
          "sameLabel": true,
          "liveLaunches": 2,
          "noStore": true,
          "revocations": 2
        }
      },
      "revoked": true
    }
  },
  "android": {
    "startedAt": "2026-10-13T23:47:24.086Z",
    "completedAt": "2026-10-13T23:50:26.327Z",
    "measurements": {
      "unlockMs": 7052,
      "airplaneRecoveredMs": 3635,
      "dozeRecoveredMs": 133,
      "collaboration": {
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true
      }
    }
  },
  "androidPush": {
    "startedAt": "2026-10-13T23:47:24.086Z",
    "completedAt": "2026-10-14T00:12:11.755Z",
    "measurements": {
      "passed": true,
      "platform": {
        "webApk": true,
        "dndOff": true
      },
      "phases": {
        "subscription_ready": {
          "enabled": true,
          "dndOff": true,
          "phaseElapsedMs": 19165
        },
        "private_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 2868,
          "dndOff": true,
          "phaseElapsedMs": 70050
        },
        "session_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1310,
          "dndOff": true,
          "phaseElapsedMs": 47169
        },
        "preview_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 2132,
          "dndOff": true,
          "phaseElapsedMs": 50797
        },
        "attention_tap_verified": {
          "control": true,
          "revalidated": true,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 49518
        },
        "activity_stop_verified": {
          "knownBusyPolls": 2,
          "viewOnly": true,
          "dndOff": true,
          "phaseElapsedMs": 57459
        },
        "stale_generation_verified": {
          "sameInstance": true,
          "generationIncrement": 1,
          "launches": 0,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 66883
        },
        "clear_verified": {
          "authoritativeClear": true,
          "freshRequestRetained": true,
          "dndOff": true,
          "phaseElapsedMs": 75819
        },
        "triage_verified": {
          "fifo": true,
          "holdAdvanced": true,
          "heldNotificationClosed": true,
          "pendingRetained": true,
          "requeued": true,
          "allHeld": true,
          "staleHoldReleased": true,
          "undoRestored": true,
          "undoExpired": true,
          "attentionRestored": true,
          "shownAll": true,
          "mutations": 0,
          "dndOff": true,
          "phaseElapsedMs": 138681
        },
        "stale_taps_verified": {
          "resolved": true,
          "rearmed": true,
          "replaced": true,
          "expired": true,
          "launches": 0,
          "scrubbed": true,
          "replayed": true,
          "dndOff": true,
          "phaseElapsedMs": 236560
        },
        "force_stop_verified": {
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 94537
        },
        "permission_verified": {
          "suppressed": true,
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 100122
        },
        "lock_resume_verified": {
          "lockedDelivery": true,
          "resumed": true,
          "dndOff": true,
          "phaseElapsedMs": 29802
        },
        "network_verified": {
          "wifiDelivery": true,
          "cellularDelivery": true,
          "airplaneSuppressed": true,
          "recovered": true,
          "dndOff": true,
          "phaseElapsedMs": 150597
        },
        "doze_verified": {
          "dndOff": true,
          "phaseElapsedMs": 78245
        },
        "forbidden_sinks_verified": {
          "detectable": true,
          "clean": true,
          "sinks": 10,
          "findings": 0,
          "gatewayLogsDiscarded": true,
          "dndOff": true,
          "phaseElapsedMs": 12648
        },
        "evidence_complete": {
          "passed": true,
          "dndOff": true,
          "phaseElapsedMs": 138
        }
      },
      "cleanup": {
        "restored": true,
        "deviceRestored": true,
        "browserRestored": true,
        "fixtureStopped": true
      }
    }
  },
  "androidPushCleanup": {
    "startedAt": "2026-10-14T00:12:11.759Z",
    "completedAt": "2026-10-14T00:12:12.377Z",
    "measurements": {
      "restored": true
    }
  },
  "deviceCloud": {
    "startedAt": "2026-10-13T23:47:24.086Z",
    "completedAt": "2026-10-14T00:20:04.866Z",
    "measurements": {
      "passed": true,
      "targets": {
        "iphone": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "homeScreenApp": true,
          "alertsEnabled": true,
          "subscriptionOmitsExpirationTime": true,
          "deliveredMs": 4216,
          "tapOpenedControl": true,
          "tapUrlScrubbed": true,
          "alertsDisabled": true,
          "tunnelRefusals": 24,
          "elapsedMs": 103957
        },
        "ipad": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 1,
          "elapsedMs": 41674
        },
        "android": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 39,
          "elapsedMs": 38757
        }
      },
      "audit": {
        "records": 3,
        "recordsExposingLinks": 0,
        "recordsWithMedia": 0
      }
    }
  },
  "deviceCloudCleanup": {
    "startedAt": "2026-10-14T00:20:04.868Z",
    "completedAt": "2026-10-14T00:20:07.240Z",
    "measurements": {
      "restored": true
    }
  },
  "relay": {
    "startedAt": "2026-10-13T23:47:24.086Z",
    "completedAt": "2026-10-14T00:17:25.376Z",
    "measurements": {
      "durationSeconds": 1800,
      "transitions": 8
    }
  },
  "cleanup": {
    "startedAt": "2026-10-14T00:20:54.514Z",
    "completedAt": "2026-10-14T00:21:00.317Z",
    "measurements": {
      "gatewayProcesses": 0,
      "gatewayListeners": 0,
      "liveOmpHosts": 0
    }
  },
  "windows": {
    "startedAt": "2026-10-13T23:35:56.236Z",
    "completedAt": "2026-10-14T00:25:25.185Z",
    "measurements": {
      "timings": {
        "firewall_created": 1580,
        "instance_created": 675,
        "transport_ready": 375141,
        "toolchain_staged": 594950,
        "predecessor_installed": 24752,
        "candidate_upgraded": 47972,
        "reboot_requested": 23782,
        "prelogin_verified": 141249,
        "postlogin_ready": 38583,
        "doctor_passed": 12018,
        "omp_published": 32879,
        "pixel_verified": 1367264,
        "omp_revoked": 9024,
        "readiness_rotated": 9906,
        "predecessor_restored": 12659,
        "candidate_restored": 13058,
        "candidate_uninstalled": 7888,
        "standard_user_prepared": 8732,
        "standard_tailnet_released": 5990,
        "standard_tailnet_joined": 3512,
        "standard_interactive_ready": 13015,
        "standard_candidate_installed": 21471,
        "standard_reboot_requested": 21949,
        "standard_prelogin_verified": 130741,
        "standard_postlogin_ready": 20406,
        "standard_doctor_passed": 8869,
        "standard_readiness_rotated": 10498,
        "standard_candidate_uninstalled": 9549,
        "evidence_complete": 0
      },
      "observations": {
        "windowsBuild": 26100,
        "cpus": 4,
        "memoryMiB": 8186,
        "transportStabilitySamples": 3,
        "transportStabilityDurationMs": 70985,
        "taggedNode": true,
        "tunMode": true,
        "funnelOff": true,
        "loopbackOnly": true,
        "configPreserved": true,
        "readinessPreserved": true,
        "restored": true,
        "doctorChecks": 18,
        "doctorTrue": 15,
        "doctorIdentityAllowed": false,
        "doctorPwa": false,
        "doctorSessionHealth": false,
        "doctorSecurityHeaders": true,
        "logonTrigger": true,
        "interactivePrincipal": true,
        "logonTriggerScoped": true,
        "preloginSamples": 3,
        "preloginDurationMs": 55489,
        "automaticStartMs": 38583,
        "namedPipe": true,
        "generation": 1,
        "viewStatus": 200,
        "controlStatus": 200,
        "staleViewStatus": 409,
        "staleControlStatus": 409,
        "noStore": true,
        "pixelIdentityAccepted": true,
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true,
        "revoked": true,
        "readinessChanged": true,
        "historySelected": true,
        "uninstalled": true,
        "standardUserNonAdmin": true,
        "standardUserNoSecurityPrivilege": true,
        "standardPreloginSamples": 3,
        "standardPreloginDurationMs": 48794,
        "standardAutomaticStartMs": 20406,
        "standardDoctorChecks": 18,
        "standardDoctorTrue": 15,
        "standardReadinessChanged": true,
        "standardUninstalled": true,
        "standardConfigPreserved": true,
        "standardReadinessPreserved": true
      },
      "doctor": {
        "true": 15,
        "total": 18
      }
    }
  },
  "windowsCleanup": {
    "startedAt": "2026-10-14T00:25:25.186Z",
    "completedAt": "2026-10-14T00:25:51.853Z",
    "measurements": {
      "instancesRemaining": 0,
      "firewallsRemaining": 0,
      "tailnetDeleted": true,
      "vaultRemoved": true
    }
  }
}
```

</details>

**Runtime equivalence gate:** the approval driver must compare a clean stable-channel build with the qualified candidate before merging. The receipt does not prove that later build comparison. Only release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json and schemas/stable-release.schema.json may differ.

### Published-byte Studio/Pixel verification

Recorded 2026-10-13. Published-byte smoke passed against the stable source and digest above. Stock OMP 18.10.2, binary SHA-256 `df9f273cb0120795940f918f94a22aa8d7c667f2fd97ec21e74f841c2c878f3e`; app asset `/assets/app.5c4a35b3f50f.js`.

```json
{
  "gateway": {
    "installed": true,
    "configPreserved": true,
    "doctorChecks": 18
  },
  "tailscaleServe": {
    "changed": false,
    "unrelatedMappingsPreserved": true
  },
  "android": {
    "viewReadOnly": true,
    "controlWritable": true,
    "capabilitySinksClean": true,
    "samePageRecovery": true,
    "installedWebApk": true
  },
  "leaveInstalled": {
    "gateway": true,
    "mainlineOmp": true,
    "webApk": true
  },
  "status": {
    "installed": true,
    "active": true,
    "ready": true,
    "diverged": false,
    "activeVersion": "0.7.7-0fea7fbc2cb0",
    "serviceVersion": "0.7.7-0fea7fbc2cb0"
  }
}
```

This smoke does not expand the candidate matrix or qualify bare-metal Mac, Windows, cloud browsers or background Push beyond their candidate lanes.

## Mainline v0.7.6 — published stable

**Updated:** 2026-10-10. [v0.7.6](https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.7.6) was published at **2026-10-11T00:23:22Z** and is GitHub Latest. [Signed release workflow](https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/38098167507).

**Stable source:** `d0964b48276a21fa1f235a14029856f4438b5025`.<br>
**Stable archive SHA-256:** `417b69aa86a78891d6a45da7911091f26c0586ae38b69607ef76966136abf03e`.

**Candidate:** [v0.7.6-prealpha.2](https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.7.6-prealpha.2).<br>
**Source:** `28fbdf57b1eab8437f2bba0cd1f753960cc3925f`.<br>
**Archive SHA-256:** `96a78778608b1b232fd586abc012199c2cd10d6edb7b38a60f241d09720a89cd`.<br>
**Predecessor:** published `v0.7.5`.

This release uses stock OMP v18.8.9 as its engineering baseline. The 8 changelog entries below record the changes since v0.7.5. Historical receipts do not qualify these bytes.

### Candidate evidence

Schema 3 campaign 2026-10-10T23:05:18.721Z–2026-10-10T23:52:42.422Z; orchestrator `28fbdf57b1eab8437f2bba0cd1f753960cc3925f`.

| Lane | Attempts | Evidence |
|---|---|---|
| artifacts | 1 | Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; v0.7.5 verified by digest-pinned historical Cosign bundles 3/3 (no GitHub build attestations). |
| debian | 1 | Run 38093821367 succeeded (https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/38093821367); OS/kernel versions and migration counts are not exported. |
| macos | 1 | VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon 76a98a98c7adbe5481e1ac3ede2b7c6c889443dc5edd10929854e1ebde10c1b7. |
| ompPublication | 1 | Stock OMP v18.8.9; generation 1; publication, View/Control, new-generation/fork/resume and revocation. |
| android | 1 | Pixel 8 Pro, Android 17 build CP3A.261005.005, Chrome 154.0.8037.126; same-page unlock 6991 ms, Airplane 6906 ms, Doze 123 ms; 7/7 detectable; clean. |
| androidPush | 1 | Android 17, Chrome 154.0.8037.126, installed WebAPK; force-stop delivered_while_force_stopped, Doze delivered_after_doze_exit; outcomes are observed variants, not delivery guarantees. |
| androidPushCleanup | 1 | Device, browser and fixture restored. |
| deviceCloud | 1 | TestingBot real devices, tunnel 4.9: iPhone 17 Pro Max (26.6, safari 26.6); iPad (9th generation) (26.6, safari 26.6); Galaxy S26 (16.0.0, chrome 145.0.7632.159). Home Screen alerts do not qualify lock-screen presentation. |
| deviceCloudCleanup | 1 | Restored. |
| relay | 1 | 1800 seconds, 2026-10-10T23:18:36.965Z–2026-10-10T23:48:36.978Z; 2 transitions, final phase live. Eight-hour endurance is not claimed. |
| cleanup | 1 | Zero gateway processes, listeners and live OMP hosts. |
| windows | 1 | Windows x86-64 build 26100; 4 CPUs, 8186 MiB; Administrator upgrade/rollback from v0.7.5 and fresh standard-account lifecycle; interactive logon, not unattended boot. |
| windowsCleanup | 1 | Zero instances and firewalls; tailnet node deleted and access vault removed. |

<details>
<summary>Public measured results (booleans and numbers; private identities omitted)</summary>

```json
{
  "artifacts": {
    "startedAt": "2026-10-10T23:05:27.000Z",
    "completedAt": "2026-10-10T23:05:45.498Z",
    "measurements": {
      "signedTag": true,
      "predecessor": {
        "signedTag": true
      }
    }
  },
  "debian": {
    "startedAt": "2026-10-10T23:05:45.499Z",
    "completedAt": "2026-10-10T23:15:54.773Z",
    "measurements": {
      "runId": 38093821367
    }
  },
  "macos": {
    "startedAt": "2026-10-10T23:15:54.777Z",
    "completedAt": "2026-10-10T23:18:24.051Z",
    "measurements": {
      "guestRebootChanged": true,
      "consoleLogin": true,
      "readinessPreserved": true
    }
  },
  "ompPublication": {
    "startedAt": "2026-10-10T23:18:24.271Z",
    "completedAt": "2026-10-10T23:49:26.342Z",
    "measurements": {
      "generation": 1,
      "published": true,
      "lifecycle": {
        "newGeneration": {
          "sameInstance": true,
          "generationDelta": 1,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "fork": {
          "sameInstance": true,
          "generationDelta": 1,
          "syntheticMessages": 2,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "resumed": {
          "newInstance": true,
          "generation": 1,
          "sameLabel": true,
          "liveLaunches": 2,
          "noStore": true,
          "revocations": 2
        }
      },
      "revoked": true
    }
  },
  "android": {
    "startedAt": "2026-10-10T23:18:35.673Z",
    "completedAt": "2026-10-10T23:21:41.169Z",
    "measurements": {
      "unlockMs": 6991,
      "airplaneRecoveredMs": 6906,
      "dozeRecoveredMs": 123,
      "collaboration": {
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true
      }
    }
  },
  "androidPush": {
    "startedAt": "2026-10-10T23:18:35.673Z",
    "completedAt": "2026-10-10T23:46:44.330Z",
    "measurements": {
      "passed": true,
      "platform": {
        "webApk": true,
        "dndOff": true
      },
      "phases": {
        "subscription_ready": {
          "enabled": true,
          "dndOff": true,
          "phaseElapsedMs": 13772
        },
        "private_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 5749,
          "dndOff": true,
          "phaseElapsedMs": 47034
        },
        "session_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 2213,
          "dndOff": true,
          "phaseElapsedMs": 60935
        },
        "preview_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 2159,
          "dndOff": true,
          "phaseElapsedMs": 49080
        },
        "attention_tap_verified": {
          "control": true,
          "revalidated": true,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 50444
        },
        "activity_stop_verified": {
          "knownBusyPolls": 2,
          "viewOnly": true,
          "dndOff": true,
          "phaseElapsedMs": 57828
        },
        "stale_generation_verified": {
          "sameInstance": true,
          "generationIncrement": 1,
          "launches": 0,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 66402
        },
        "clear_verified": {
          "authoritativeClear": true,
          "freshRequestRetained": true,
          "dndOff": true,
          "phaseElapsedMs": 75399
        },
        "triage_verified": {
          "fifo": true,
          "holdAdvanced": true,
          "heldNotificationClosed": true,
          "pendingRetained": true,
          "requeued": true,
          "allHeld": true,
          "staleHoldReleased": true,
          "undoRestored": true,
          "undoExpired": true,
          "attentionRestored": true,
          "shownAll": true,
          "mutations": 0,
          "dndOff": true,
          "phaseElapsedMs": 153157
        },
        "stale_taps_verified": {
          "resolved": true,
          "rearmed": true,
          "replaced": true,
          "expired": true,
          "launches": 0,
          "scrubbed": true,
          "replayed": true,
          "dndOff": true,
          "phaseElapsedMs": 233181
        },
        "force_stop_verified": {
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 94195
        },
        "permission_verified": {
          "suppressed": true,
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 109565
        },
        "lock_resume_verified": {
          "lockedDelivery": true,
          "resumed": true,
          "dndOff": true,
          "phaseElapsedMs": 30231
        },
        "network_verified": {
          "wifiDelivery": true,
          "cellularDelivery": true,
          "airplaneSuppressed": true,
          "recovered": true,
          "dndOff": true,
          "phaseElapsedMs": 159890
        },
        "doze_verified": {
          "dndOff": true,
          "phaseElapsedMs": 89090
        },
        "forbidden_sinks_verified": {
          "detectable": true,
          "clean": true,
          "sinks": 10,
          "findings": 0,
          "gatewayLogsDiscarded": true,
          "dndOff": true,
          "phaseElapsedMs": 12790
        },
        "evidence_complete": {
          "passed": true,
          "dndOff": true,
          "phaseElapsedMs": 144
        }
      },
      "cleanup": {
        "restored": true,
        "deviceRestored": true,
        "browserRestored": true,
        "fixtureStopped": true
      }
    }
  },
  "androidPushCleanup": {
    "startedAt": "2026-10-10T23:46:44.333Z",
    "completedAt": "2026-10-10T23:46:45.009Z",
    "measurements": {
      "restored": true
    }
  },
  "deviceCloud": {
    "startedAt": "2026-10-10T23:18:35.673Z",
    "completedAt": "2026-10-10T23:24:34.230Z",
    "measurements": {
      "passed": true,
      "targets": {
        "iphone": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "homeScreenApp": true,
          "alertsEnabled": true,
          "subscriptionOmitsExpirationTime": true,
          "deliveredMs": 7537,
          "tapOpenedControl": true,
          "tapUrlScrubbed": true,
          "alertsDisabled": true,
          "tunnelRefusals": 11,
          "elapsedMs": 91852
        },
        "ipad": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 27,
          "elapsedMs": 31508
        },
        "android": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 28,
          "elapsedMs": 31693
        }
      },
      "audit": {
        "records": 3,
        "recordsExposingLinks": 0,
        "recordsWithMedia": 0
      }
    }
  },
  "deviceCloudCleanup": {
    "startedAt": "2026-10-10T23:24:34.231Z",
    "completedAt": "2026-10-10T23:24:35.884Z",
    "measurements": {
      "restored": true
    }
  },
  "relay": {
    "startedAt": "2026-10-10T23:18:35.673Z",
    "completedAt": "2026-10-10T23:48:36.989Z",
    "measurements": {
      "durationSeconds": 1800,
      "transitions": 2
    }
  },
  "cleanup": {
    "startedAt": "2026-10-10T23:49:26.349Z",
    "completedAt": "2026-10-10T23:49:32.305Z",
    "measurements": {
      "gatewayProcesses": 0,
      "gatewayListeners": 0,
      "liveOmpHosts": 0
    }
  },
  "windows": {
    "startedAt": "2026-10-10T23:05:45.499Z",
    "completedAt": "2026-10-10T23:52:14.998Z",
    "measurements": {
      "timings": {
        "firewall_created": 1924,
        "instance_created": 838,
        "transport_ready": 404799,
        "toolchain_staged": 660650,
        "predecessor_installed": 23562,
        "candidate_upgraded": 46584,
        "reboot_requested": 23962,
        "prelogin_verified": 145691,
        "postlogin_ready": 54687,
        "doctor_passed": 12951,
        "omp_published": 30054,
        "pixel_verified": 1065663,
        "omp_revoked": 10124,
        "readiness_rotated": 10220,
        "predecessor_restored": 12668,
        "candidate_restored": 13189,
        "candidate_uninstalled": 7438,
        "standard_user_prepared": 9013,
        "standard_tailnet_released": 6329,
        "standard_tailnet_joined": 3729,
        "standard_interactive_ready": 14077,
        "standard_candidate_installed": 21590,
        "standard_reboot_requested": 22093,
        "standard_prelogin_verified": 132463,
        "standard_postlogin_ready": 24548,
        "standard_doctor_passed": 9126,
        "standard_readiness_rotated": 10709,
        "standard_candidate_uninstalled": 9455,
        "evidence_complete": 0
      },
      "observations": {
        "windowsBuild": 26100,
        "cpus": 4,
        "memoryMiB": 8186,
        "transportStabilitySamples": 3,
        "transportStabilityDurationMs": 69252,
        "taggedNode": true,
        "tunMode": true,
        "funnelOff": true,
        "loopbackOnly": true,
        "configPreserved": true,
        "readinessPreserved": true,
        "restored": true,
        "doctorChecks": 18,
        "doctorTrue": 15,
        "doctorIdentityAllowed": false,
        "doctorPwa": false,
        "doctorSessionHealth": false,
        "doctorSecurityHeaders": true,
        "logonTrigger": true,
        "interactivePrincipal": true,
        "logonTriggerScoped": true,
        "preloginSamples": 3,
        "preloginDurationMs": 57252,
        "automaticStartMs": 54687,
        "namedPipe": true,
        "generation": 1,
        "viewStatus": 200,
        "controlStatus": 200,
        "staleViewStatus": 409,
        "staleControlStatus": 409,
        "noStore": true,
        "pixelIdentityAccepted": true,
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true,
        "revoked": true,
        "readinessChanged": true,
        "historySelected": true,
        "uninstalled": true,
        "standardUserNonAdmin": true,
        "standardUserNoSecurityPrivilege": true,
        "standardPreloginSamples": 3,
        "standardPreloginDurationMs": 49255,
        "standardAutomaticStartMs": 24548,
        "standardDoctorChecks": 18,
        "standardDoctorTrue": 15,
        "standardReadinessChanged": true,
        "standardUninstalled": true,
        "standardConfigPreserved": true,
        "standardReadinessPreserved": true
      },
      "doctor": {
        "true": 15,
        "total": 18
      }
    }
  },
  "windowsCleanup": {
    "startedAt": "2026-10-10T23:52:14.998Z",
    "completedAt": "2026-10-10T23:52:42.418Z",
    "measurements": {
      "instancesRemaining": 0,
      "firewallsRemaining": 0,
      "tailnetDeleted": true,
      "vaultRemoved": true
    }
  }
}
```

</details>

**Runtime equivalence gate:** the approval driver must compare a clean stable-channel build with the qualified candidate before merging. The receipt does not prove that later build comparison. Only release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json and schemas/stable-release.schema.json may differ.

### Published-byte Studio/Pixel verification

Recorded 2026-10-10. Published-byte smoke passed against the stable source and digest above. Stock OMP 18.8.9, binary SHA-256 `32990111e8a2f43f2cd17c4a74ed290063bc9a94884bb2744f6ce7877f796070`; app asset `/assets/app.5c4a35b3f50f.js`.

```json
{
  "gateway": {
    "installed": true,
    "configPreserved": true,
    "doctorChecks": 18
  },
  "tailscaleServe": {
    "changed": false,
    "unrelatedMappingsPreserved": true
  },
  "android": {
    "viewReadOnly": true,
    "controlWritable": true,
    "capabilitySinksClean": true,
    "samePageRecovery": true,
    "installedWebApk": true
  },
  "leaveInstalled": {
    "gateway": true,
    "mainlineOmp": true,
    "webApk": true
  },
  "status": {
    "installed": true,
    "active": true,
    "ready": true,
    "diverged": false,
    "activeVersion": "0.7.6-7a81e6eab73a",
    "serviceVersion": "0.7.6-7a81e6eab73a"
  }
}
```

This smoke does not expand the candidate matrix or qualify bare-metal Mac, Windows, cloud browsers or background Push beyond their candidate lanes.

## Mainline v0.7.5 — published stable

**Updated:** 2026-10-08. [v0.7.5](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.5) was published at **2026-10-08T16:38:49Z** and is GitHub Latest. [Signed release workflow](https://github.com/alphastorm/omp-session-gateway/actions/runs/37810219313).

**Stable source:** `89eafb4da642c62dcaa5a4e6d6d9dc9f9f635431`.<br>
**Stable archive SHA-256:** `171dec1a9902c934c99060b250f209cf627ce194d07da1412b35ad419c3ec57c`.

**Candidate:** [v0.7.5-prealpha.2](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.5-prealpha.2).<br>
**Source:** `98b101ed8b2459cf6d635a7390ed6f10faae75ed`.<br>
**Archive SHA-256:** `06e76965c559b6bdf1b96539c65083dda6a03f5db08957ac4e445dc454a71a53`.<br>
**Predecessor:** published `v0.7.4`.

This release uses stock OMP v18.8.3 as its engineering baseline. The 8 changelog entries below record the changes since v0.7.4. Historical receipts do not qualify these bytes.

### Candidate evidence

Schema 3 campaign 2026-10-08T07:27:12.176Z–2026-10-08T10:40:17.842Z; orchestrator `98b101ed8b2459cf6d635a7390ed6f10faae75ed`.

| Lane | Attempts | Evidence |
|---|---|---|
| artifacts | 2 | Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; v0.7.4 verified the same way. |
| debian | 1 | Run 37743587268 succeeded (https://github.com/alphastorm/omp-session-gateway/actions/runs/37743587268); OS/kernel versions and migration counts are not exported. |
| macos | 1 | VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon efce5da3bd67933b98288068fc9768acc02c5cdd0af0a897418f6d99a31fded9. |
| ompPublication | 2 | Stock OMP v18.8.3; generation 1; publication, View/Control, new-generation/fork/resume and revocation. |
| android | 1 | Pixel 8 Pro, Android 17 build CP3A.261005.005, Chrome 154.0.8037.126; same-page unlock 7138 ms, Airplane 4036 ms, Doze 137 ms; 7/7 detectable; clean. |
| androidPush | 1 | Android 17, Chrome 154.0.8037.126, installed WebAPK; force-stop delivered_while_force_stopped, Doze delivered_after_doze_exit; outcomes are observed variants, not delivery guarantees. |
| androidPushCleanup | 1 | Device, browser and fixture restored. |
| deviceCloud | 2 | TestingBot real devices, tunnel 4.9: iPhone 17 Pro Max (26.6, safari 26.6); iPad (9th generation) (26.6, safari 26.6); Galaxy S26 (16.0.0, chrome 145.0.7632.159). Home Screen alerts do not qualify lock-screen presentation. |
| deviceCloudCleanup | 2 | Restored. |
| relay | 1 | 1800 seconds, 2026-10-08T07:40:25.015Z–2026-10-08T08:10:25.030Z; 2 transitions, final phase live. Eight-hour endurance is not claimed. |
| cleanup | 2 | Zero gateway processes, listeners and live OMP hosts. |
| windows | 1 | Windows x86-64 build 26100; 4 CPUs, 8186 MiB; Administrator upgrade/rollback from v0.7.4 and fresh standard-account lifecycle; interactive logon, not unattended boot. |
| windowsCleanup | 1 | Zero instances and firewalls; tailnet node deleted and access vault removed. |

<details>
<summary>Public measured results (booleans and numbers; private identities omitted)</summary>

```json
{
  "artifacts": {
    "startedAt": "2026-10-08T10:32:34.382Z",
    "completedAt": "2026-10-08T10:33:03.746Z",
    "measurements": {
      "signedTag": true,
      "predecessor": {
        "signedTag": true
      }
    }
  },
  "debian": {
    "startedAt": "2026-10-08T07:27:54.783Z",
    "completedAt": "2026-10-08T07:37:34.751Z",
    "measurements": {
      "runId": 37743587268
    }
  },
  "macos": {
    "startedAt": "2026-10-08T07:37:34.755Z",
    "completedAt": "2026-10-08T07:40:13.835Z",
    "measurements": {
      "guestRebootChanged": true,
      "consoleLogin": true,
      "readinessPreserved": true
    }
  },
  "ompPublication": {
    "startedAt": "2026-10-08T10:34:20.789Z",
    "completedAt": "2026-10-08T10:40:11.529Z",
    "measurements": {
      "generation": 1,
      "published": true,
      "lifecycle": {
        "newGeneration": {
          "sameInstance": true,
          "generationDelta": 1,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "fork": {
          "sameInstance": true,
          "generationDelta": 1,
          "syntheticMessages": 2,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "resumed": {
          "newInstance": true,
          "generation": 1,
          "sameLabel": true,
          "liveLaunches": 2,
          "noStore": true,
          "revocations": 2
        }
      },
      "revoked": true
    }
  },
  "android": {
    "startedAt": "2026-10-08T07:40:23.612Z",
    "completedAt": "2026-10-08T07:43:27.525Z",
    "measurements": {
      "unlockMs": 7138,
      "airplaneRecoveredMs": 4036,
      "dozeRecoveredMs": 137,
      "collaboration": {
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true
      }
    }
  },
  "androidPush": {
    "startedAt": "2026-10-08T07:40:23.612Z",
    "completedAt": "2026-10-08T08:15:53.339Z",
    "measurements": {
      "passed": true,
      "platform": {
        "webApk": true,
        "dndOff": true
      },
      "phases": {
        "subscription_ready": {
          "enabled": true,
          "dndOff": true,
          "phaseElapsedMs": 13026
        },
        "private_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1342,
          "dndOff": true,
          "phaseElapsedMs": 47047
        },
        "session_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1378,
          "dndOff": true,
          "phaseElapsedMs": 49861
        },
        "preview_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 2246,
          "dndOff": true,
          "phaseElapsedMs": 60769
        },
        "attention_tap_verified": {
          "control": true,
          "revalidated": true,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 49914
        },
        "activity_stop_verified": {
          "knownBusyPolls": 2,
          "viewOnly": true,
          "dndOff": true,
          "phaseElapsedMs": 58000
        },
        "stale_generation_verified": {
          "sameInstance": true,
          "generationIncrement": 1,
          "launches": 0,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 65814
        },
        "clear_verified": {
          "authoritativeClear": true,
          "freshRequestRetained": true,
          "dndOff": true,
          "phaseElapsedMs": 76639
        },
        "triage_verified": {
          "fifo": true,
          "holdAdvanced": true,
          "heldNotificationClosed": true,
          "pendingRetained": true,
          "requeued": true,
          "allHeld": true,
          "staleHoldReleased": true,
          "undoRestored": true,
          "undoExpired": true,
          "attentionRestored": true,
          "shownAll": true,
          "mutations": 0,
          "dndOff": true,
          "phaseElapsedMs": 138512
        },
        "stale_taps_verified": {
          "resolved": true,
          "rearmed": true,
          "replaced": true,
          "expired": true,
          "launches": 0,
          "scrubbed": true,
          "replayed": true,
          "dndOff": true,
          "phaseElapsedMs": 236604
        },
        "force_stop_verified": {
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 94140
        },
        "permission_verified": {
          "suppressed": true,
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 110165
        },
        "lock_resume_verified": {
          "lockedDelivery": true,
          "resumed": true,
          "dndOff": true,
          "phaseElapsedMs": 30088
        },
        "network_verified": {
          "wifiDelivery": true,
          "cellularDelivery": true,
          "airplaneSuppressed": true,
          "recovered": true,
          "dndOff": true,
          "phaseElapsedMs": 159698
        },
        "doze_verified": {
          "dndOff": true,
          "phaseElapsedMs": 89371
        },
        "forbidden_sinks_verified": {
          "detectable": true,
          "clean": true,
          "sinks": 10,
          "findings": 0,
          "gatewayLogsDiscarded": true,
          "dndOff": true,
          "phaseElapsedMs": 13199
        },
        "evidence_complete": {
          "passed": true,
          "dndOff": true,
          "phaseElapsedMs": 153
        }
      },
      "cleanup": {
        "restored": true,
        "deviceRestored": true,
        "browserRestored": true,
        "fixtureStopped": true
      }
    }
  },
  "androidPushCleanup": {
    "startedAt": "2026-10-08T08:15:53.343Z",
    "completedAt": "2026-10-08T08:15:54.268Z",
    "measurements": {
      "restored": true
    }
  },
  "deviceCloud": {
    "startedAt": "2026-10-08T10:34:31.298Z",
    "completedAt": "2026-10-08T10:39:26.944Z",
    "measurements": {
      "passed": true,
      "targets": {
        "iphone": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "homeScreenApp": true,
          "alertsEnabled": true,
          "subscriptionOmitsExpirationTime": true,
          "deliveredMs": 6945,
          "tapOpenedControl": true,
          "tapUrlScrubbed": true,
          "alertsDisabled": true,
          "tunnelRefusals": 18,
          "elapsedMs": 95919
        },
        "ipad": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 30,
          "elapsedMs": 37019
        },
        "android": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 38,
          "elapsedMs": 32170
        }
      },
      "audit": {
        "records": 3,
        "recordsExposingLinks": 0,
        "recordsWithMedia": 0
      }
    }
  },
  "deviceCloudCleanup": {
    "startedAt": "2026-10-08T10:39:26.945Z",
    "completedAt": "2026-10-08T10:39:29.013Z",
    "measurements": {
      "restored": true
    }
  },
  "relay": {
    "startedAt": "2026-10-08T07:40:23.613Z",
    "completedAt": "2026-10-08T08:10:25.040Z",
    "measurements": {
      "durationSeconds": 1800,
      "transitions": 2
    }
  },
  "cleanup": {
    "startedAt": "2026-10-08T10:40:11.534Z",
    "completedAt": "2026-10-08T10:40:17.839Z",
    "measurements": {
      "gatewayProcesses": 0,
      "gatewayListeners": 0,
      "liveOmpHosts": 0
    }
  },
  "windows": {
    "startedAt": "2026-10-08T07:27:54.783Z",
    "completedAt": "2026-10-08T08:21:44.193Z",
    "measurements": {
      "timings": {
        "firewall_created": 822,
        "instance_created": 674,
        "transport_ready": 420908,
        "toolchain_staged": 538112,
        "predecessor_installed": 23343,
        "candidate_upgraded": 48094,
        "reboot_requested": 24429,
        "prelogin_verified": 148083,
        "postlogin_ready": 54044,
        "doctor_passed": 13612,
        "omp_published": 30023,
        "pixel_verified": 1589569,
        "omp_revoked": 15951,
        "readiness_rotated": 10485,
        "predecessor_restored": 13547,
        "candidate_restored": 14276,
        "candidate_uninstalled": 8311,
        "standard_user_prepared": 9582,
        "standard_tailnet_released": 6496,
        "standard_tailnet_joined": 4011,
        "standard_interactive_ready": 15257,
        "standard_candidate_installed": 21558,
        "standard_reboot_requested": 22438,
        "standard_prelogin_verified": 137843,
        "standard_postlogin_ready": 24325,
        "standard_doctor_passed": 10578,
        "standard_readiness_rotated": 11033,
        "standard_candidate_uninstalled": 10711,
        "evidence_complete": 0
      },
      "observations": {
        "windowsBuild": 26100,
        "cpus": 4,
        "memoryMiB": 8186,
        "transportStabilitySamples": 3,
        "transportStabilityDurationMs": 69739,
        "taggedNode": true,
        "tunMode": true,
        "funnelOff": true,
        "loopbackOnly": true,
        "configPreserved": true,
        "readinessPreserved": true,
        "restored": true,
        "doctorChecks": 18,
        "doctorTrue": 15,
        "doctorIdentityAllowed": false,
        "doctorPwa": false,
        "doctorSessionHealth": false,
        "doctorSecurityHeaders": true,
        "logonTrigger": true,
        "interactivePrincipal": true,
        "logonTriggerScoped": true,
        "preloginSamples": 3,
        "preloginDurationMs": 59030,
        "automaticStartMs": 54044,
        "namedPipe": true,
        "generation": 1,
        "viewStatus": 200,
        "controlStatus": 200,
        "staleViewStatus": 409,
        "staleControlStatus": 409,
        "noStore": true,
        "pixelIdentityAccepted": true,
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true,
        "revoked": true,
        "readinessChanged": true,
        "historySelected": true,
        "uninstalled": true,
        "standardUserNonAdmin": true,
        "standardUserNoSecurityPrivilege": true,
        "standardPreloginSamples": 3,
        "standardPreloginDurationMs": 51876,
        "standardAutomaticStartMs": 24325,
        "standardDoctorChecks": 18,
        "standardDoctorTrue": 15,
        "standardReadinessChanged": true,
        "standardUninstalled": true,
        "standardConfigPreserved": true,
        "standardReadinessPreserved": true
      },
      "doctor": {
        "true": 15,
        "total": 18
      }
    }
  },
  "windowsCleanup": {
    "startedAt": "2026-10-08T08:21:44.194Z",
    "completedAt": "2026-10-08T08:22:12.121Z",
    "measurements": {
      "instancesRemaining": 0,
      "firewallsRemaining": 0,
      "tailnetDeleted": true,
      "vaultRemoved": true
    }
  }
}
```

</details>

**Runtime equivalence gate:** the approval driver must compare a clean stable-channel build with the qualified candidate before merging. The receipt does not prove that later build comparison. Only release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json and schemas/stable-release.schema.json may differ.

### Published-byte Studio/Pixel verification

Recorded 2026-10-08. Published-byte smoke passed against the stable source and digest above. Stock OMP 18.8.3, binary SHA-256 `ab1482816804bc7b73d1b1407f62e06656657f9d9636e860466ab004bd20cef2`; app asset `/assets/app.5c4a35b3f50f.js`.

```json
{
  "gateway": {
    "installed": true,
    "configPreserved": true,
    "doctorChecks": 18
  },
  "tailscaleServe": {
    "changed": false,
    "unrelatedMappingsPreserved": true
  },
  "android": {
    "viewReadOnly": true,
    "controlWritable": true,
    "capabilitySinksClean": true,
    "samePageRecovery": true,
    "installedWebApk": true
  },
  "leaveInstalled": {
    "gateway": true,
    "mainlineOmp": true,
    "webApk": true
  },
  "status": {
    "installed": true,
    "active": true,
    "ready": true,
    "diverged": false,
    "activeVersion": "0.7.5-7419a591a040",
    "serviceVersion": "0.7.5-7419a591a040"
  }
}
```

This smoke does not expand the candidate matrix or qualify bare-metal Mac, Windows, cloud browsers or background Push beyond their candidate lanes.

## Mainline v0.7.4 — published stable

**Updated:** 2026-10-03. [v0.7.4](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.4) was published at **2026-10-03T19:02:03Z** and is GitHub Latest. [Signed release workflow](https://github.com/alphastorm/omp-session-gateway/actions/runs/37146354037).

**Stable source:** `39e3d57232f4b3e09ffe9d8a61b409ee0f01762b`.<br>
**Stable archive SHA-256:** `80525ced892fee94b902cc2c486cb2e6b9943121d78910b61adf14faef10efe3`.

**Candidate:** [v0.7.4-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.4-prealpha.1).<br>
**Source:** `dcfa0b32503ca83e71e15d2872eff920831b14ac`.<br>
**Archive SHA-256:** `71399ede57f4dce15bdcc7f25be9030c8dbf58d69f7a56eab790caefba043b00`.<br>
**Predecessor:** published `v0.7.3`.

This release uses stock OMP v18.5.1 as its engineering baseline. The 2 changelog entries below record the changes since v0.7.3. Historical receipts do not qualify these bytes.

### Candidate evidence

Schema 3 campaign 2026-10-03T17:59:22.873Z–2026-10-03T18:50:09.671Z; orchestrator `dcfa0b32503ca83e71e15d2872eff920831b14ac`.

| Lane | Attempts | Evidence |
|---|---|---|
| artifacts | 1 | Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; v0.7.3 verified the same way. |
| debian | 1 | Run 37142569203 succeeded (https://github.com/alphastorm/omp-session-gateway/actions/runs/37142569203); OS/kernel versions and migration counts are not exported. |
| macos | 1 | VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon 4e707d5c7a44bf15a2e61afb6856e0a5ec3a86e11364e68714e99bde1745e6d1. |
| ompPublication | 1 | Stock OMP v18.5.1; generation 1; publication, View/Control, new-generation/fork/resume and revocation. |
| android | 1 | Pixel 10 Pro, Android 17 build CP3A.260905.009, Chrome 154.0.8037.126; same-page unlock 6697 ms, Airplane 3606 ms, Doze 122 ms; 7/7 detectable; clean. |
| androidPush | 1 | Android 17, Chrome 154.0.8037.126, installed WebAPK; force-stop delivered_while_force_stopped, Doze delivered_after_doze_exit; outcomes are observed variants, not delivery guarantees. |
| androidPushCleanup | 1 | Device, browser and fixture restored. |
| deviceCloud | 1 | TestingBot real devices, tunnel 4.9: iPhone 17 Pro Max (26.6, safari 26.6); iPad (9th generation) (26.6, safari 26.6); Galaxy S25 (15.0.0, chrome 149.0.7827.159). Home Screen alerts do not qualify lock-screen presentation. |
| deviceCloudCleanup | 1 | Restored. |
| relay | 1 | 1800 seconds, 2026-10-03T18:12:19.444Z–2026-10-03T18:42:19.460Z; 2 transitions, final phase live. Eight-hour endurance is not claimed. |
| cleanup | 1 | Zero gateway processes, listeners and live OMP hosts. |
| windows | 1 | Windows x86-64 build 26100; 4 CPUs, 8186 MiB; Administrator upgrade/rollback from v0.7.3 and fresh standard-account lifecycle; interactive logon, not unattended boot. |
| windowsCleanup | 1 | Zero instances and firewalls; tailnet node deleted and access vault removed. |

<details>
<summary>Public measured results (booleans and numbers; private identities omitted)</summary>

```json
{
  "artifacts": {
    "startedAt": "2026-10-03T17:59:33.165Z",
    "completedAt": "2026-10-03T18:00:04.207Z",
    "measurements": {
      "signedTag": true,
      "predecessor": {
        "signedTag": true
      }
    }
  },
  "debian": {
    "startedAt": "2026-10-03T18:00:04.209Z",
    "completedAt": "2026-10-03T18:09:48.751Z",
    "measurements": {
      "runId": 37142569203
    }
  },
  "macos": {
    "startedAt": "2026-10-03T18:09:48.754Z",
    "completedAt": "2026-10-03T18:12:09.590Z",
    "measurements": {
      "guestRebootChanged": true,
      "consoleLogin": true,
      "readinessPreserved": true
    }
  },
  "ompPublication": {
    "startedAt": "2026-10-03T18:12:09.790Z",
    "completedAt": "2026-10-03T18:44:29.017Z",
    "measurements": {
      "generation": 1,
      "published": true,
      "lifecycle": {
        "newGeneration": {
          "sameInstance": true,
          "generationDelta": 1,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "fork": {
          "sameInstance": true,
          "generationDelta": 1,
          "syntheticMessages": 2,
          "staleRejected": true,
          "liveLaunches": 2,
          "noStore": true
        },
        "resumed": {
          "newInstance": true,
          "generation": 1,
          "sameLabel": true,
          "liveLaunches": 2,
          "noStore": true,
          "revocations": 2
        }
      },
      "revoked": true
    }
  },
  "android": {
    "startedAt": "2026-10-03T18:12:18.161Z",
    "completedAt": "2026-10-03T18:15:23.494Z",
    "measurements": {
      "unlockMs": 6697,
      "airplaneRecoveredMs": 3606,
      "dozeRecoveredMs": 122,
      "collaboration": {
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true
      }
    }
  },
  "androidPush": {
    "startedAt": "2026-10-03T18:12:18.161Z",
    "completedAt": "2026-10-03T18:43:39.846Z",
    "measurements": {
      "passed": true,
      "platform": {
        "webApk": true,
        "dndOff": true
      },
      "phases": {
        "subscription_ready": {
          "enabled": true,
          "dndOff": true,
          "phaseElapsedMs": 20043
        },
        "private_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1653,
          "dndOff": true,
          "phaseElapsedMs": 56643
        },
        "session_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1946,
          "dndOff": true,
          "phaseElapsedMs": 61499
        },
        "preview_verified": {
          "delivered": true,
          "locked": true,
          "singleNotification": true,
          "detailMatched": true,
          "elapsedMs": 1928,
          "dndOff": true,
          "phaseElapsedMs": 58937
        },
        "attention_tap_verified": {
          "control": true,
          "revalidated": true,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 50530
        },
        "activity_stop_verified": {
          "knownBusyPolls": 2,
          "viewOnly": true,
          "dndOff": true,
          "phaseElapsedMs": 61059
        },
        "stale_generation_verified": {
          "sameInstance": true,
          "generationIncrement": 1,
          "launches": 0,
          "scrubbed": true,
          "dndOff": true,
          "phaseElapsedMs": 65264
        },
        "clear_verified": {
          "authoritativeClear": true,
          "freshRequestRetained": true,
          "dndOff": true,
          "phaseElapsedMs": 73192
        },
        "triage_verified": {
          "fifo": true,
          "holdAdvanced": true,
          "heldNotificationClosed": true,
          "pendingRetained": true,
          "requeued": true,
          "allHeld": true,
          "staleHoldReleased": true,
          "undoRestored": true,
          "undoExpired": true,
          "attentionRestored": true,
          "shownAll": true,
          "mutations": 0,
          "dndOff": true,
          "phaseElapsedMs": 149141
        },
        "stale_taps_verified": {
          "resolved": true,
          "rearmed": true,
          "replaced": true,
          "expired": true,
          "launches": 0,
          "scrubbed": true,
          "replayed": true,
          "dndOff": true,
          "phaseElapsedMs": 242482
        },
        "force_stop_verified": {
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 108589
        },
        "permission_verified": {
          "suppressed": true,
          "freshDelivery": true,
          "dndOff": true,
          "phaseElapsedMs": 130055
        },
        "lock_resume_verified": {
          "lockedDelivery": true,
          "resumed": true,
          "dndOff": true,
          "phaseElapsedMs": 29597
        },
        "network_verified": {
          "wifiDelivery": true,
          "cellularDelivery": true,
          "airplaneSuppressed": true,
          "recovered": true,
          "dndOff": true,
          "phaseElapsedMs": 180546
        },
        "doze_verified": {
          "dndOff": true,
          "phaseElapsedMs": 98785
        },
        "forbidden_sinks_verified": {
          "detectable": true,
          "clean": true,
          "sinks": 10,
          "findings": 0,
          "gatewayLogsDiscarded": true,
          "dndOff": true,
          "phaseElapsedMs": 14429
        },
        "evidence_complete": {
          "passed": true,
          "dndOff": true,
          "phaseElapsedMs": 256
        }
      },
      "cleanup": {
        "restored": true,
        "deviceRestored": true,
        "browserRestored": true,
        "fixtureStopped": true
      }
    }
  },
  "androidPushCleanup": {
    "startedAt": "2026-10-03T18:43:39.848Z",
    "completedAt": "2026-10-03T18:43:40.641Z",
    "measurements": {
      "restored": true
    }
  },
  "deviceCloud": {
    "startedAt": "2026-10-03T18:12:18.161Z",
    "completedAt": "2026-10-03T18:19:49.311Z",
    "measurements": {
      "passed": true,
      "targets": {
        "iphone": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "homeScreenApp": true,
          "alertsEnabled": true,
          "subscriptionOmitsExpirationTime": true,
          "deliveredMs": 7989,
          "tapOpenedControl": true,
          "tapUrlScrubbed": true,
          "alertsDisabled": true,
          "tunnelRefusals": 19,
          "elapsedMs": 92063
        },
        "ipad": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 24,
          "elapsedMs": 35573
        },
        "android": {
          "appAssetMatched": true,
          "viewReadOnly": true,
          "controlWritable": true,
          "promptAccepted": true,
          "returnedToDirectory": true,
          "sinksDetectable": 7,
          "sinkFindings": 0,
          "tunnelRefusals": 13,
          "elapsedMs": 30458
        }
      },
      "audit": {
        "records": 3,
        "recordsExposingLinks": 0,
        "recordsWithMedia": 0
      }
    }
  },
  "deviceCloudCleanup": {
    "startedAt": "2026-10-03T18:19:49.312Z",
    "completedAt": "2026-10-03T18:19:50.909Z",
    "measurements": {
      "restored": true
    }
  },
  "relay": {
    "startedAt": "2026-10-03T18:12:18.161Z",
    "completedAt": "2026-10-03T18:42:19.468Z",
    "measurements": {
      "durationSeconds": 1800,
      "transitions": 2
    }
  },
  "cleanup": {
    "startedAt": "2026-10-03T18:44:29.022Z",
    "completedAt": "2026-10-03T18:44:34.875Z",
    "measurements": {
      "gatewayProcesses": 0,
      "gatewayListeners": 0,
      "liveOmpHosts": 0
    }
  },
  "windows": {
    "startedAt": "2026-10-03T18:00:04.209Z",
    "completedAt": "2026-10-03T18:49:39.298Z",
    "measurements": {
      "timings": {
        "firewall_created": 3094,
        "instance_created": 4995,
        "transport_ready": 426479,
        "toolchain_staged": 527891,
        "predecessor_installed": 31624,
        "candidate_upgraded": 60724,
        "reboot_requested": 25516,
        "prelogin_verified": 152474,
        "postlogin_ready": 63509,
        "doctor_passed": 15723,
        "omp_published": 35582,
        "pixel_verified": 1251658,
        "omp_revoked": 10970,
        "readiness_rotated": 9890,
        "predecessor_restored": 12365,
        "candidate_restored": 12545,
        "candidate_uninstalled": 7435,
        "standard_user_prepared": 9109,
        "standard_tailnet_released": 6357,
        "standard_tailnet_joined": 3672,
        "standard_interactive_ready": 13718,
        "standard_candidate_installed": 18656,
        "standard_reboot_requested": 22926,
        "standard_prelogin_verified": 157914,
        "standard_postlogin_ready": 32076,
        "standard_doctor_passed": 9065,
        "standard_readiness_rotated": 9903,
        "standard_candidate_uninstalled": 9330,
        "evidence_complete": 0
      },
      "observations": {
        "windowsBuild": 26100,
        "cpus": 4,
        "memoryMiB": 8186,
        "transportStabilitySamples": 3,
        "transportStabilityDurationMs": 72517,
        "taggedNode": true,
        "tunMode": true,
        "funnelOff": true,
        "loopbackOnly": true,
        "configPreserved": true,
        "readinessPreserved": true,
        "restored": true,
        "doctorChecks": 18,
        "doctorTrue": 15,
        "doctorIdentityAllowed": false,
        "doctorPwa": false,
        "doctorSessionHealth": false,
        "doctorSecurityHeaders": true,
        "logonTrigger": true,
        "interactivePrincipal": true,
        "logonTriggerScoped": true,
        "preloginSamples": 3,
        "preloginDurationMs": 60738,
        "automaticStartMs": 63509,
        "namedPipe": true,
        "generation": 1,
        "viewStatus": 200,
        "controlStatus": 200,
        "staleViewStatus": 409,
        "staleControlStatus": 409,
        "noStore": true,
        "pixelIdentityAccepted": true,
        "viewReadOnly": true,
        "controlWritable": true,
        "promptAccepted": true,
        "returnedToDirectory": true,
        "revoked": true,
        "readinessChanged": true,
        "historySelected": true,
        "uninstalled": true,
        "standardUserNonAdmin": true,
        "standardUserNoSecurityPrivilege": true,
        "standardPreloginSamples": 3,
        "standardPreloginDurationMs": 46381,
        "standardAutomaticStartMs": 32076,
        "standardDoctorChecks": 18,
        "standardDoctorTrue": 15,
        "standardReadinessChanged": true,
        "standardUninstalled": true,
        "standardConfigPreserved": true,
        "standardReadinessPreserved": true
      },
      "doctor": {
        "true": 15,
        "total": 18
      }
    }
  },
  "windowsCleanup": {
    "startedAt": "2026-10-03T18:49:39.299Z",
    "completedAt": "2026-10-03T18:50:09.668Z",
    "measurements": {
      "instancesRemaining": 0,
      "firewallsRemaining": 0,
      "tailnetDeleted": true,
      "vaultRemoved": true
    }
  }
}
```

</details>

**Runtime equivalence gate:** the approval driver must compare a clean stable-channel build with the qualified candidate before merging. The receipt does not prove that later build comparison. Only release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json and schemas/stable-release.schema.json may differ.

### Published-byte Studio/Pixel verification

Recorded 2026-10-03. Published-byte smoke passed against the stable source and digest above. Stock OMP 18.5.1, binary SHA-256 `fc62b280c50923f779e9af14e0ba12d24cbf3db6b2757106a8ad127b3a3274a9`; app asset `/assets/app.5c4a35b3f50f.js`.

```json
{
  "gateway": {
    "installed": true,
    "configPreserved": true,
    "doctorChecks": 18
  },
  "tailscaleServe": {
    "changed": false,
    "unrelatedMappingsPreserved": true
  },
  "android": {
    "viewReadOnly": true,
    "controlWritable": true,
    "capabilitySinksClean": true,
    "samePageRecovery": true,
    "installedWebApk": true
  },
  "leaveInstalled": {
    "gateway": true,
    "mainlineOmp": true,
    "webApk": true
  },
  "status": {
    "installed": true,
    "active": true,
    "ready": true,
    "diverged": false,
    "activeVersion": "0.7.4-9a9fd8f2c4d0",
    "serviceVersion": "0.7.4-9a9fd8f2c4d0"
  }
}
```

This smoke does not expand the candidate matrix or qualify bare-metal Mac, Windows, cloud browsers or background Push beyond their candidate lanes.

## Embedded client v18.12.6 — source integration only

On 2026-10-24, the independent browser client and npm wire pin advance from v18.4.2 to v18.12.6
(`45c35e40c46166dc726ccc52f5d27f40f2449f99`). This includes render coalescing, streaming-tail
Markdown and linear-time parser/math sources, idle drawer polling shutdown, and eval rendering.
The host baseline fields stay v18.12.5 and the minimum host stays 18.1.20. Gateway security/UX
patches are carried or explicitly retired where upstream provides them; exact provenance and
dispositions are in `packages/collab-client/upstream/UPSTREAM.json`.

This is not a new release, native-device qualification, signed-candidate result, or relay soak.
Published v0.8.0 and all historical records below retain their original evidence. Rolling back
to v0.8.0 also restores its v18.4.2 embedded client; the two trees no longer share client bytes.

## Engineering baseline v18.12.5 — source pins only

On 2026-10-21 (#423), `scripts/upstream-pins.ts` derived the stock OMP v18.12.5 source pin
`d5cd750e41fede277f9eb933455da92a0738915e`, tree `1d19bf65af4446fa9bfda4ed0a7d09315b02d9c8`, and
the Darwin arm64 and Windows x64 native hashes from official npm tarballs after verifying
registry integrity. Source review from v18.12.3 found registry v1, the discovery file format and
socket paths, the relay protocol, `collab.autoStart`, and every collaboration, `collab-web`, and
`packages/wire/src/index.ts` source unchanged; can1357/oh-my-pi#16361 documents GitLab MR
references for the extension `ctx.annotations` API in `docs/extensions.md` and the version bumps
touch `package.json`, neither of which changes what the gateway reads or sends. The embedded
client stays at v18.4.2. No canary, candidate, campaign, or platform qualification is claimed;
the published matrix above is unchanged.

## Engineering baseline v18.12.3 — source pins only

On 2026-10-19 (#409), `scripts/upstream-pins.ts` derived the stock OMP v18.12.3 source pin
`53a0377db6845e0dae606146130766ec92d407fd`, tree `51822a49a4cc7eebabdb1e848c79f8aa873deb40`, and
the Darwin arm64 and Windows x64 native hashes from official npm tarballs after verifying
registry integrity. Source review from v18.10.2 found registry v1, the discovery file format and
socket paths, the relay protocol, and `collab.autoStart` unchanged; can1357/oh-my-pi#15680 adds
an optional `runtime` field to session entries, can1357/oh-my-pi#15467 changes a CLI guest's
prompt-cache key, and can1357/oh-my-pi#12730 changes a `collab-web` eval renderer the embedded
client does not import, none of which changes what the gateway reads or sends. The embedded
client stays at v18.4.2. No canary, candidate, campaign, or platform qualification is claimed;
the published matrix above is unchanged.

## Engineering baseline v18.10.2 — source pins only

On 2026-10-12 (#398), `scripts/upstream-pins.ts` derived the stock OMP v18.10.2 source pin
`c8913466dd7bf92040de911f8e00e30b8f4e48a2`, tree `bbe0b2fa461fc34bf45cb544432a24e767f155ec`, and
the Darwin arm64 and Windows x64 native hashes from official npm tarballs after verifying
registry integrity. Source review from v18.8.9 found registry v1, the discovery file format, the
relay protocol, and `collab.autoStart` unchanged; can1357/oh-my-pi@a608a9ca07 moves the registry
onto native IPC with the same request and response lines and relocates overlong sockets under
`/tmp/omp-<euid>`, can1357/oh-my-pi#14387 adds host relay pings, and can1357/oh-my-pi#15260 adds
`ctx.annotations`, none of which changes what the gateway reads or sends. The embedded client
stays at v18.4.2. No canary, candidate, campaign, or platform qualification is claimed; the
published matrix above is unchanged.

## Engineering baseline v18.8.9 — source pins only

On 2026-10-10 (#390), `scripts/upstream-pins.ts` derived the stock OMP v18.8.9 source pin
`fa5ff4a3a977a28b93d025f4cf50f046e019f18c`, tree `3017032181e2f9a11ee8269dabb963dc5acb4703`, and
the Darwin arm64 and Windows x64 native hashes from official npm tarballs after verifying
registry integrity. Source review from v18.8.3 found the collaboration host, registry, settings,
`collab-web`, and `packages/wire/src/index.ts` unchanged, so registry v1, discovery, the relay
protocol, and `collab.autoStart` are unchanged; can1357/oh-my-pi#13620 adds
`/fork pane|window|tab` and can1357/oh-my-pi#15077 adds `/dump anon`, neither used by the gateway.
The embedded client stays at v18.4.2. No canary, candidate, campaign, or platform qualification is
claimed; the published matrix above is unchanged.

## Engineering baseline v18.8.3 — source pins only

On 2026-10-08 (#368), `scripts/upstream-pins.ts` derived the stock OMP v18.8.3 source pin
`3e3c488a58d294e3a10051da588628e2cfb9d35c`, tree `307c09c826aff7f0818c7aa19722c504646a49fd`, and
the Darwin arm64 and Windows x64 native hashes from official npm tarballs after verifying
registry integrity. Source review from v18.5.1 found registry v1, discovery, the relay protocol,
and `collab.autoStart` unchanged; can1357/oh-my-pi#14714 skips frame mirroring without a guest,
and from 18.8.1 a generated `sessionName` may carry a title-card prefix. The embedded client stays
at v18.4.2. No canary, candidate, campaign, or platform qualification is claimed; the published
matrix above is unchanged.

## v0.7.4 original operator evidence — retained historical record

The release generator migration preserves the original operator-authored excerpts below, with line wrapping only.
They record v0.7.4 facts that cannot be reconstructed solely from the schema-3 candidate receipt,
published-byte smoke JSON, publication metadata, and installed-status JSON: notably the later
46-file runtime comparison, verification details, exact smoke interval and attempt count.
All original versions, tags, dates, digests, URLs, lane counts and evidence links remain in these
excerpts; no historical observation is silently promoted into a newly generated campaign.
The source is the published v0.7.4 record and its claim surfaces as retained at `a550808`.
Superseded “current” wording inside these excerpts applies only to that named release.

<details>
<summary>Original changed excerpt: docs/RELEASE_STATUS.md</summary>

````markdown
## Mainline v0.7.4 — published stable

**Updated:** 2026-10-03. [v0.7.4](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.4)
was published at **2026-10-03T19:02:03Z** and is GitHub Latest, with six assets. Signed release workflow
[37146354037](https://github.com/alphastorm/omp-session-gateway/actions/runs/37146354037)
(`signed-release.yml`) succeeded. The signed annotated tag `v0.7.4` points to the stable source below.
The assets are `omp-session-gateway-0.7.4-bun.tar`, its `.sigstore.json`,
`omp-session-gateway-0.7.4.spdx.json`, its `.sigstore.json`, `SHA256SUMS`, and
`SHA256SUMS.sigstore.json`. On the Studio's operator account, the release attestation and all six
assets verified, the checksums matched, and GitHub build attestations and Sigstore bundles each
verified 3/3 for the archive, SBOM, and `SHA256SUMS`. A local
`OMP_RELEASE_CHANNEL=stable bun run release:build` of the tag on that account reproduced the
published archive digest byte-for-byte.

**Stable source:** `39e3d57232f4b3e09ffe9d8a61b409ee0f01762b` (merge of approve PR #363).<br>
**Stable archive SHA-256:** `80525ced892fee94b902cc2c486cb2e6b9943121d78910b61adf14faef10efe3`.

The published-byte Studio/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.7.4-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.4-prealpha.1).<br>
**Source:** `dcfa0b32503ca83e71e15d2872eff920831b14ac`.<br>
**Archive SHA-256:** `71399ede57f4dce15bdcc7f25be9030c8dbf58d69f7a56eab790caefba043b00`.<br>
**Predecessor:** published `v0.7.3`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v074-predecessor-compatibility).

The candidate carries no gateway runtime fixes since v0.7.3; the apps/packages changes are release
version bumps only. The OMP engineering baseline moves to stock OMP v18.5.1 (#361), built from
source at `d0cc52397dc2a68d39cba49b0009b9e50ffd643e`. It is the first release that retries a
`collab.autoStart` launch whose relay is unreachable or times out (can1357/oh-my-pi#14112). The
embedded client and its v18.4.2 wire pin remain unchanged. The campaign ran from the Studio's
operator account against the retained Virtualization.framework guest (VirtualMac2,1), not its
physical host; every physical Pixel lane ran on the Pixel 10 Pro attached to the Studio.

### Candidate evidence — 2026-10-03

All thirteen lanes passed on their first attempt in one campaign, orchestrator
`dcfa0b32503ca83e71e15d2872eff920831b14ac` (the candidate source), 17:59:22Z–18:50:09Z. Before it,
the Studio preflight passed, and a development lifecycle run with stock OMP 18.5.1 from npm on the
Studio passed new-generation, fork, and resume; those runs are tested evidence, not qualification.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; predecessor v0.7.3 verified the same way |
| Debian | [37142569203](https://github.com/alphastorm/omp-session-gateway/actions/runs/37142569203) succeeded against the candidate archive, and its droplet and ephemeral SSH key teardown step succeeded. The receipt export records the successful run, not its OS/kernel versions or migration/recovery invariant count |
| Mac | Virtualization.framework guest, VirtualMac2,1, macOS 27.0 arm64, hosted on the Mac Studio; orchestrated from the Studio's operator account; stock OMP v18.5.1 built from source with native addon `4e707d5c7a44`; doctor 18/18, rollback 23/23, changed guest reboot epoch, console login, and preserved readiness |
| Windows | Windows build 26100, x86-64, on a disposable VM with 4 CPUs and 8,186 MiB reported memory. As Administrator, the candidate installed over published v0.7.3 with stock OMP v18.5.1 built from source. A real reboot passed 3 pre-login samples over 60,738 ms, with automatic start 63,509 ms after interactive logon. Doctor passed 15/18, with only the tagged node's identityAllowed, pwa, and sessionHealth false. The named pipe published at generation 1, View and Control returned 200, stale generations 409, all no-store. The Pixel accepted the user identity, with View read-only, Control writable, the prompt accepted, and the return to directory. Revocation, readiness rotation, history-selected rollback, restoration, and uninstall passed with configuration and readiness preserved. A fresh standard-account install, without Administrator membership or SeSecurityPrivilege, passed a real reboot with 3 pre-login samples over 46,381 ms, automatic start 32,076 ms after that account's logon, doctor 15/18, readiness rotation, and uninstall, preserving configuration and readiness |
| OMP publication | stock OMP v18.5.1 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked. New-generation and fork transitions kept the instance, advanced generation by 1, rejected stale launches, and each allowed two live launches; fork used two synthetic messages. Resume created a new instance at generation 1 with the same label, two live launches, and two revocations; all launches were no-store |
| Android | Pixel 10 Pro, Android 17 build CP3A.260905.009, Chrome 154.0.8037.126; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 6,697 ms, Airplane 3,606 ms, Doze 122 ms; all seven forbidden capability sinks detectable and clean |
| Background Push | Pixel 10 Pro, Android 17, Chrome 154.0.8037.126, installed WebAPK, stock OMP 18.5.1 fixtures: Private, Session, and Preview lock-screen delivery in 1,653, 1,946, and 1,928 ms respectively, each a single notification with matching detail; tap to current Control, stop tap to View only after two known-busy polls, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery. Triage passed FIFO, hold/advance, held-notification close, pending retention, requeue, all-held, stale-hold release, undo/expiry, attention restoration, and show-all with zero mutations. Resolved, rearmed, replaced, expired, and replayed stale taps were scrubbed without a launch. Force-stop delivered_while_force_stopped and Doze delivered_after_doze_exit are observed variants, never delivery guarantees; ten forbidden sinks detectable and clean |
| Push cleanup | device, browser, and fixture restored |
| Device cloud | TestingBot real devices through tunnel 4.9: iPhone 17 Pro Max (iOS 26.6, Safari 26.6), iPad (9th generation, iPadOS 26.6, Safari 26.6), and Galaxy S25 (SM-S931B, Android 15.0.0, Chrome 149.0.7827.159). Each matched the candidate app asset, with View read-only, Control writable, prompt accepted, return to directory, and seven detectable clean sinks. Tunnel refusals were 19, 24, and 13 respectively. All three vendor records exposed no links or media. The iPhone Home Screen app enabled alerts; its subscription omitted expirationTime on web.push.apple.com. Delivery took 7,989 ms; the tap opened current Control with a scrubbed address, and alerts were disabled afterwards. This is not a lock-screen presentation claim |
| Device-cloud cleanup | restored |
| Relay | 1,800 seconds, 2026-10-03T18:12:19.444Z–18:42:19.460Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts |
| Windows cleanup | zero instances and firewalls remaining; tailnet node deleted and access vault removed |

**Runtime equivalence gate:** passed. On the Studio's operator account with Bun 1.4.0, a clean
`OMP_RELEASE_CHANNEL=stable bun run release:build` of approval tree
`42e3b0ce1a256d66dc1c423c3b6d7f91d254a948` was compared with the candidate archive after its digest
verified: `{"compared":46,"differing":[]}`. Only the existing workflow exclusions apply:
release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json.
The ledger-only commit that records this result changes no archive member.

**Assurance scope:** The guest does not exercise physical firmware, FileVault unlock, Secure Boot, power loss, physical sleep/wake, or physical device drivers (ADR-033); guest reboot and console-login recovery do not qualify a bare-metal Mac or startup before login.
The guest exercises the macOS kernel, launchd, loginwindow, per-user LaunchAgent, native addon,
filesystem, TUN interface, and guest reboot. Physical Android and cloud-device evidence is separate.
A fresh 1,800-second relay check replaces the eight-hour gate; eight-hour endurance and bounded
memory growth are not claimed. Windows is limited to the recorded x86-64 build at interactive
logon; upgrade, rollback, OMP, and Pixel journeys ran as Administrator, while the standard-account
claim is fresh installation, reboot/logon start, doctor, rotation, and uninstall. The lifecycle
and Push triage/stale-tap results cover the recorded scenarios, not arbitrary behavior on every
platform. Force-stop and Doze are observed variants, not delivery guarantees. The iPhone receipt
proves Home Screen delivery and a Control tap, not lock-screen presentation; lock, Airplane, Doze,
force-stop, and cellular behavior stay Pixel-only. The export does not identify the cloud tunnel's
host or observed Serve identity. The campaign injects no relay fault, so the auto-start retry rests
on upstream's tests and the tracer recorded under the v18.5.1 baseline below, not on a lane.
Desktop Safari and broader host/browser combinations remain unqualified. Every other release gate
stays required.

### Published-byte Studio/Pixel verification

The smoke ran on the Studio's operator account, at the Studio's own tailnet origin, with the
attached Pixel 10 Pro, from tooling at the tag commit `39e3d57`, detached in tmux,
**19:03:40Z–19:07:17Z**:
`bun run smoke:release -- --tag v0.7.4 --archive-sha256 80525ced892fee94b902cc2c486cb2e6b9943121d78910b61adf14faef10efe3 --rebuild-omp`.
`--rebuild-omp` replaced the account's Bun global stock OMP 18.4.12 with the release's pinned
**18.5.1**, installed by its own `bun add --global --exact @oh-my-pi/pi-coding-agent@18.5.1`, binary
SHA-256 `fc62b280c50923f779e9af14e0ba12d24cbf3db6b2757106a8ad127b3a3274a9`. The smoke therefore
matches the engineering baseline the candidate qualified from source.

Its result JSON recorded `sourceCommit: 39e3d57232f4b3e09ffe9d8a61b409ee0f01762b` and
`appAsset: /assets/app.5c4a35b3f50f.js`. The gateway upgraded from v0.7.3 (`installed: true`) with
`configPreserved: true`, `readinessTokenPreserved: true`, and `doctorChecks: 18`. Tailscale Serve
recorded `changed: false` and `unrelatedMappingsPreserved: true`. On the Pixel 10 Pro, the Android
result recorded `viewReadOnly: true`, `controlWritable: true`, `capabilitySinksClean: true`,
`samePageRecovery: true`, and `installedWebApk: true`. The `leaveInstalled` result recorded
`gateway: true`, `mainlineOmp: true`, and `webApk: true`.

Afterwards, `status` reported active, ready, and not diverged, with active and service versions
`0.7.4-9a9fd8f2c4d0`. The retained runtime directories on the operator account are
`0.7.2-0e6104d6ee0b`, `0.7.3-11c3cc5ce86f`, and `0.7.4-9a9fd8f2c4d0`. The smoke does not expand
the exact candidate host/client matrix or turn the guest qualification into bare-metal
qualification. Windows, cloud browsers, and background Push rest on their respective candidate
lanes above.
````

</details>

<details>
<summary>Original changed excerpt: docs/UPGRADE_ROLLBACK.md</summary>

````markdown
## v0.7.4 predecessor compatibility

The selected predecessor is published v0.7.3. Gateway rollback does not change the separately
running OMP process. Both versions embed the same OMP 18.4.2 collaboration client and wire pin;
v0.7.4 moves the engineering baseline to stock OMP v18.5.1 without gateway runtime fixes.
Rolling back to v0.7.3 therefore does not undo a gateway runtime fix or replace OMP with the
predecessor's engineering baseline. After a v0.7.4 install, `rollback --to` can select only the
runtimes pruning retained. The candidate passed 23/23 rollback invariants in the
Virtualization.framework guest (VirtualMac2,1) and Windows history-selected predecessor restoration.
Earlier predecessors retain the compatibility limits recorded below; none of their historical
receipts qualifies this candidate.
````

</details>

<details>
<summary>Original changed excerpt: docs/COMPATIBILITY.md</summary>

````markdown
| Surface | Status | Tested by | Qualified on hardware |
|---|---|---|---|
| Linux host | Supported | `portable-source (ubuntu-24.04)`, `implementation-checks`, `linux-arm64-source-checkout` (aarch64), daily `canary` against stock OMP | Debian lane passed; exact OS/kernel versions not enumerated in the current export |
| macOS host | Supported | `portable-source (macos-latest)` | Virtualization.framework guest, macOS 27.0 arm64 (`VirtualMac2,1`), hosted on the Mac Studio; not bare-metal qualification |
| Windows host | Supported | `portable-source (windows-latest)`, `windows-service-lifecycle`, daily `canary-windows` against stock OMP | Windows x86-64 build 26100, started at interactive logon, from an Administrator or a standard account |
| Chrome and Chromium | Supported | `browser-core` desktop Chromium; `browser-notifications` full suite at Pixel sizes | Chrome on Android 17, Pixel 10 Pro (core and Push); Chrome on Android 15, a cloud Galaxy S25 |
| Edge and other Chromium-based browsers | Supported through Chromium | `browser-core` desktop Chromium; the client has no Edge-specific code path | None |
| Firefox | Supported | `browser-core` desktop Firefox | None |
| Safari and WebKit | Supported | `browser-core` desktop WebKit | Safari on iOS and iPadOS 26.6, a cloud iPhone 17 Pro Max and iPad (9th generation) |
| Android | Supported | `browser-notifications` at measured Pixel sizes | Pixel 10 Pro (core and Push), Android 17, Chrome; a cloud Galaxy S25, Android 15, Chrome |
| iPhone and iPad | Tested as a browser | `browser-core` WebKit with iPhone-class emulation | iPhone 17 Pro Max, iOS 26.6, and iPad (9th generation), iPadOS 26.6, with Safari, on cloud devices (ADR-032) |

**Supported** means every listed lane stays green (on each change, the canaries daily) and bug
reports are accepted. **Qualified on hardware** names what a signed release passed on real
machines, in [Current claim](#current-claim) and the [release ledger](RELEASE_STATUS.md), except
the explicitly named retained macOS guest under ADR-033. Hosted
runners and browser engines are not physical devices, so neither column stands in for the other;
see the [status vocabulary](#status-vocabulary).

- **Installing as a PWA.** Chromium browsers install from the browser menu on desktop and Android.
  Safari installs with Add to Home Screen on iPhone and iPad, and Add to Dock on macOS. Desktop
  Firefox has no web-app install; it works in a tab.
- **Background alerts** (Web Push) are qualified in full only on the Pixel with Chrome on Android,
  where force-stop and forced Doze outcomes are observed variants, never guaranteed delivery. iPhone
  and iPad offer them only to a Home Screen app (iOS and iPadOS 16.4+); v0.6.0 and earlier cannot
  enable them there because WebKit omits a null `expirationTime` from the subscription (#274); the
  fix ships in v0.6.1. Playwright's WebKit has no push service, so the compatibility lane runs
  desktop WebKit without service workers and does not test WebKit push. From v0.6.2, a cloud iPhone
  also qualifies enabling alerts in the Home Screen app, delivery with the app in the background,
  and the tap into Control, but not lock-screen presentation (ADR-032).
- **Browser versions.** The client uses CSS `color-mix()`, `:has()`, and dynamic viewport units, so
  browsers older than roughly Chrome and Edge 111, Firefox 121, and Safari 16.2 render incorrectly.
- **Windows** starts the gateway at interactive logon, not at unattended boot.

## v0.5.0 compatibility correction

Published v0.4.2 rejects the additive `busy` field emitted by OMP 18.2.9 and can hide live sessions
(#219). The v0.5.0 parser fix accepts validated booleans and preserves absent/null as unknown.
Mixed current/legacy host discovery and View/Control are covered by real local IPC regression tests.
This does not advance the pinned baseline, native/client versions, or exact qualification matrix.

v0.5.0 stop alerts use the presence of valid activity metadata, not an OMP version guess.
Older hosts keep ordinary directory/ask behavior with unknown activity. Push state and v2
attention/clear remain compatible; older workers cannot interpret stops until activation and
the browser may substitute a generic background-update notification. Open or refresh the PWA
after upgrading before relying on stop alerts.
This does not qualify physical background delivery or imply successful task completion.

## Current claim

The current Mac qualification is the Virtualization.framework guest (VirtualMac2,1), not its
physical host (ADR-033). Historical v0.7.2 Mac17,14 evidence remains unchanged in the release ledger.
The guest does not exercise physical firmware, FileVault unlock, Secure Boot, power loss, physical sleep/wake, or physical device drivers (ADR-033); guest reboot and console-login recovery do not qualify a bare-metal Mac or startup before login.

Stock mainline OMP `>= 18.1.20` is the supported host prerequisite for the current checkout.
Earlier releases are unsupported because this local registry does not exist in them.
[PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in
[v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20). Set `collab.autoStart`
only and start participating sessions with plain `omp`; no gateway-specific OMP build is required.
From v0.5.2 the gateway ignores fields OMP adds under registry v1 and validates only the fields it
reads (ADR-028); a registry version bump or a changed type for a field it reads still needs a
gateway change. The current checkout's engineering baseline is v18.5.1 (`UPSTREAM.lock.json`);
the qualified matrix below records the exact qualification of the release named next and changes
only when a candidate built from a newer baseline qualifies.

The v18.5.1 [upstream canary](https://github.com/alphastorm/omp-session-gateway/actions/runs/37140425389)
passed all ten Linux stages and all seven supported Windows stages on 2026-10-03. Windows
intentionally skips `new-generation`, `fork`, and `branch-rewind`. This is compatibility
evidence, not signed-artifact or macOS qualification. The embedded client retains v18.4.2.
v18.5.1 is the first release that retries an automatic start whose relay is unreachable or times
out ([operator settings](OMP_INTEGRATION.md#1-operator-settings)).

**Published stable:** [v0.7.4](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.4),
GitHub Latest, promoted from signed candidate v0.7.4-prealpha.1. Its published-byte smoke passed
on the first attempt on the Studio operator account, at the Studio's own tailnet origin, with the
attached Pixel 10 Pro and Bun's global stock OMP **18.5.1**, matching v0.7.4's engineering
baseline. Published v0.7.3 remains the predecessor. There are no gateway runtime fixes since
v0.7.3; v0.7.4's engineering baseline is stock OMP v18.5.1 built from source. All thirteen lanes
passed on their first attempt in the 2026-10-03 campaign, orchestrated from the Studio's operator
account. The [release ledger](RELEASE_STATUS.md) records each lane and exact source/archive
bindings; [upgrade and rollback](UPGRADE_ROLLBACK.md#v074-predecessor-compatibility) covers
v0.7.4 → v0.7.3. Physical Android acceptance and background Push both ran on the Pixel 10 Pro.
The separate published-byte smoke does not expand that matrix.

The qualified scope includes the retained-Mac new-generation/fork/resume transitions and Pixel
Push triage/stale-tap scenarios recorded in this campaign, not arbitrary attention or lifecycle
behavior on every platform. Development runs remain tested evidence only. See
[attention acceptance](ATTENTION_SPEC.md) and
[lifecycle coverage and pending Windows CI](LIFECYCLE_BRANCH_RESUME.md).

| Surface | Current contract | Qualification |
|---|---|---|
| Mainline OMP host | `>= 18.1.20`; discovery/query v1 | Exact `18.5.1` publication, View/Control, new-generation/fork/resume transitions, stale-generation rejection, and revocation passed |
| Exact qualified source | `v18.5.1`, `d0cc52397dc2a68d39cba49b0009b9e50ffd643e` | Stock OMP v18.5.1 built from source; fresh signed-candidate evidence, no fork-era transfer |
| Gateway build/runtime | Bun `1.4.0` | Signed artifact; promotion runtime comparison required before merge, with its result in the approval PR |
| Debian host | Debian lane | [37142569203](https://github.com/alphastorm/omp-session-gateway/actions/runs/37142569203) succeeded; the export does not enumerate OS/kernel versions or migration/recovery invariant counts |
| Mac host | Virtualization.framework guest, VirtualMac2,1, macOS 27.0 arm64, hosted on the Mac Studio; orchestrated from the Studio's operator account | Doctor 18/18, rollback 23/23, guest reboot and readiness preservation |
| Windows host | Windows x86-64, build `26100`, started at interactive logon, from an Administrator or a standard (non-elevated) account | Upgrade from v0.7.3, real reboot and automatic logon start, doctor, named-pipe publication, Pixel View/Control, rotation, history-selected rollback, and uninstall passed; a fresh standard-account install without `SeSecurityPrivilege` passed reboot, automatic logon start, doctor, rotation, and uninstall |
| Physical client | Pixel 10 Pro, Android 17 build `CP3A.260905.009`, Chrome `154.0.8037.126` | View/Control, same-page lock/Airplane/Doze recovery, seven detectable clean capability sinks |
| Background Web Push | Pixel 10 Pro, Android 17, Chrome `154.0.8037.126`, installed WebAPK | Lock-screen delivery at each detail level, current Control/View taps, stale-generation refusal, authoritative clear, triage, stale taps, permission revocation, and network changes passed; force-stop and Doze recorded as observed variants |
| Cloud browsers | iPhone 17 Pro Max, iOS 26.6, Safari 26.6; iPad (9th generation), iPadOS 26.6, Safari 26.6; Galaxy S25 (`SM-S931B`), Android 15.0.0, Chrome `149.0.7827.159`; TestingBot real devices | View/Control on the candidate's app bundle and seven detectable clean capability sinks on each; no vendor test record exposed links or media. Tunnel host and observed Serve identity are not recorded in the export |
| iPhone background alerts | The iPhone Home Screen app above | Alerts enabled, delivery in 7,989 ms through `web.push.apple.com`, and tap into current Control with a scrubbed address; not a lock-screen claim |
| Remote access | TUN-mode Tailscale Serve, exact allowlist, Funnel disabled | Windows receipt records TUN mode, Funnel off, loopback-only exposure, and Pixel identity acceptance |
| Default OMP relay | Fresh 1,800-second check, two transitions, final phase live | Eight-hour endurance not rerun or claimed |
````

</details>

<details>
<summary>Original changed excerpt: site/llms.txt</summary>

````text
# OMP Session Gateway

> Native integration with stock Oh My Pi (OMP) >=18.1.20. No OMP fork, custom build,
> gateway-specific OMP plugin, or publisher credential. Stable v0.7.4 is published as immutable GitHub Latest. Keep using OMP in the terminal; the separate gateway discovers collaboration-enabled
> sessions and opens OMP's own encrypted View/Control client in any modern browser, installable as a PWA where the platform supports it. One-time
> setup requires collab.autoStart, Bun 1.4.0, gateway installation, and TUN-mode Tailscale Serve
> with Funnel disabled. No per-session QR scan or link copy. Community project; not affiliated
> with or endorsed by the Oh My Pi maintainers.

## Supported platforms

- Supported and tested in CI on every change (the stock-OMP canaries run daily): Linux, macOS, and Windows gateway hosts; Chrome and Chromium, Edge through Chromium, Firefox, Safari/WebKit, and Android; iPhone and iPad as a WebKit browser, emulated in CI. Supported is not qualified: qualification is the exact hardware matrix below. Lanes: portable-source (Ubuntu, macOS, Windows), browser-core (Chromium, Firefox, WebKit, iPhone-class WebKit), browser-notifications (Pixel sizes), windows-service-lifecycle, canary and canary-windows.

## Current qualification boundary

- Stable v0.7.4 (source 39e3d57232f4b3e09ffe9d8a61b409ee0f01762b, archive SHA-256
  80525ced892fee94b902cc2c486cb2e6b9943121d78910b61adf14faef10efe3) was published 2026-10-03T19:02:03Z by
  signed-release.yml run 37146354037 and is GitHub Latest. Its signed annotated tag, archive attestation verification,
  and byte-for-byte local stable-build reproduction are recorded in the release ledger. It was promoted from signed
  candidate v0.7.4-prealpha.1 (source dcfa0b32503ca83e71e15d2872eff920831b14ac, archive SHA-256
  71399ede57f4dce15bdcc7f25be9030c8dbf58d69f7a56eab790caefba043b00). Published v0.7.3 remains the predecessor. There are
  no gateway runtime fixes since v0.7.3; the engineering baseline moves to stock OMP v18.5.1, the first release that
  retries a collab.autoStart launch whose relay is unreachable or times out. All thirteen lanes passed on their first
  attempt in one campaign, 2026-10-03 17:59:22Z–18:50:09Z, orchestrator dcfa0b32503ca83e71e15d2872eff920831b14ac, run
  from the Studio's operator account. No claim for arbitrary builds from main.
- Exact OMP v18.5.1 source: d0cc52397dc2a68d39cba49b0009b9e50ffd643e. Set only collab.autoStart (off/view/control); start participating sessions with plain omp. The gateway reads OMP discovery and queries each host; OMP does not register with the gateway. The embedded client retains its v18.4.2 provenance and wire pin.
- Debian lane: run 37142569203 succeeded against the candidate archive. The export does not enumerate OS/kernel versions or migration/recovery invariant counts.
- Virtualization.framework guest, VirtualMac2,1, macOS 27.0 arm64, hosted on the Mac Studio; orchestrated from the Studio's operator account; native addon 4e707d5c7a44, doctor 18/18, rollback 23/23, guest reboot and readiness preservation. The guest does not exercise physical firmware, FileVault unlock, Secure Boot, power loss, physical sleep/wake, or physical device drivers (ADR-033); guest reboot and console-login recovery do not qualify a bare-metal Mac or startup before login. Historical v0.7.2 Mac17,14 evidence remains unchanged in the release ledger.
- Windows build 26100, x86-64, on a disposable VM with 4 CPUs and 8,186 MiB reported memory. As Administrator, the
  candidate installed over published v0.7.3 with stock OMP v18.5.1 built from source. A real reboot passed 3 pre-login
  samples over 60,738 ms, with automatic start 63,509 ms after interactive logon. Doctor passed 15/18, with only the
  tagged node's identityAllowed, pwa, and sessionHealth false. The named pipe published at generation 1, View and
  Control returned 200, stale generations 409, all no-store. The Pixel accepted the user identity, with View read-only,
  Control writable, the prompt accepted, and the return to directory. Revocation, readiness rotation, history-selected
  rollback, restoration, and uninstall passed with configuration and readiness preserved. A fresh standard-account
  install, without Administrator membership or SeSecurityPrivilege, passed a real reboot with 3 pre-login samples over
  46,381 ms, automatic start 32,076 ms after that account's logon, doctor 15/18, readiness rotation, and uninstall,
  preserving configuration and readiness. Windows cleanup measured zero instances and firewalls; the tailnet node and
  access vault were removed. The claim is interactive logon, not boot; standard-account upgrade and rollback are not
  qualified.
- OMP publication: stock OMP v18.5.1 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked. New-generation and fork transitions kept the instance, advanced generation by 1, rejected stale launches, and each allowed two live launches; fork used two synthetic messages. Resume created a new instance at generation 1 with the same label, two live launches, and two revocations; all launches were no-store.
- Physical Android acceptance and background Push both on the Pixel 10 Pro. Core Android: Pixel 10 Pro, Android 17 build CP3A.260905.009, Chrome 154.0.8037.126; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 6,697 ms, Airplane 3,606 ms, Doze 122 ms; all seven forbidden capability sinks detectable and clean.
- Background Web Push: Pixel 10 Pro, Android 17, Chrome 154.0.8037.126, installed WebAPK: Private, Session, and Preview
  lock-screen delivery in 1,653, 1,946, and 1,928 ms respectively, each a single notification with matching detail; tap
  to current Control, stop tap to View only after two known-busy polls, stale-generation scrub without a launch,
  authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery,
  Airplane suppression and recovery. Triage passed FIFO, hold/advance, held-notification close, pending retention,
  requeue, all-held, stale-hold release, undo/expiry, attention restoration, and show-all with zero mutations. Resolved,
  rearmed, replaced, expired, and replayed stale taps were scrubbed without a launch. Force-stop
  delivered_while_force_stopped and Doze delivered_after_doze_exit are observed variants, never delivery guarantees; ten
  forbidden sinks detectable and clean. Device, browser, and fixture restored.
- TestingBot real devices through tunnel 4.9: iPhone 17 Pro Max (iOS 26.6, Safari 26.6), iPad (9th generation, iPadOS 26.6, Safari 26.6), and Galaxy S25 (SM-S931B, Android 15.0.0, Chrome 149.0.7827.159). Each matched the candidate app asset, with View read-only, Control writable, prompt accepted, return to directory, and seven detectable clean sinks. Tunnel refusals were 19, 24, and 13 respectively. All three vendor records exposed no links or media. The iPhone Home Screen app enabled alerts; its subscription omitted expirationTime on web.push.apple.com. Delivery took 7,989 ms; the tap opened current Control with a scrubbed address, and alerts were disabled afterwards. This is not a lock-screen presentation claim. Cloud cleanup restored. The export does not identify the tunnel host or observed Serve identity. Lock, Airplane, Doze, force-stop, and cellular behavior stay Pixel-only.
- Tailscale Serve over tailnet HTTPS only, TUN mode required, Funnel disabled. Fresh relay check: 1,800 seconds, 2026-10-03T18:12:19.444Z–18:42:19.460Z; two transitions, final phase live. This replaces the eight-hour gate; eight-hour endurance and bounded memory growth are not claimed. Final cleanup measured zero gateway processes, zero listeners, and zero live OMP hosts.
- Attention and lifecycle qualification is limited to the recorded guest new-generation/fork/resume and Pixel triage/stale-tap scenarios, not arbitrary behavior on every platform. Other Windows builds, desktop Safari, and new media qualification remain outside this exact claim. Android radio changes can still wedge Chrome; the proven same-page recoveries do not remove that limit.
- v0.7.3 is the migration/rollback predecessor. Both versions embed the same OMP 18.4.2 collaboration client and wire pin; there are no gateway runtime fixes to undo. Gateway rollback does not switch OMP. Retained-runtime selection and earlier predecessor limits are recorded in the upgrade/rollback document.
- In v0.5.0 and earlier, the first visit after a gateway upgrade can navigate a pending launch or an open View/Control page back to the directory: the service worker cannot see that a page is in use because Chromium reports each page's creation URL. The v0.5.1 fix never navigates from the worker.
- v0.7.4 published-byte Studio/Pixel smoke: Passed on the first attempt, 19:03:40Z–19:07:17Z, tooling at the tag commit
  39e3d57, on the Studio operator account at the Studio's own tailnet origin with the attached Pixel 10 Pro. The gateway
  upgraded from v0.7.3 (installed: true) with configPreserved: true, readinessTokenPreserved: true, doctorChecks: 18;
  tailscaleServe changed: false, unrelatedMappingsPreserved: true. --rebuild-omp installed Bun's global stock OMP
  18.5.1, binary SHA-256 fc62b280c50923f779e9af14e0ba12d24cbf3db6b2757106a8ad127b3a3274a9, matching the candidate
  engineering baseline. Asset /assets/app.5c4a35b3f50f.js; View read-only, Control writable, capability sinks clean,
  same-page recovery and installed WebAPK passed. Gateway, mainline OMP, and WebAPK were left installed. Status: active,
  ready, not diverged; active/service version 0.7.4-9a9fd8f2c4d0. Retained runtimes: 0.7.2-0e6104d6ee0b,
  0.7.3-11c3cc5ce86f, and 0.7.4-9a9fd8f2c4d0. The smoke does not expand candidate qualification.
````

</details>

<details>
<summary>Original changed excerpt: site/status/index.html</summary>

````html
<meta name="description" content="Published stable v0.7.4, stock OMP v18.5.1. Exact Debian/macOS guest/Windows/Pixel evidence and support boundaries.">
<link rel="canonical" href="https://alphastorm.github.io/omp-session-gateway/status/">
<link rel="stylesheet" href="../site.css">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<meta property="og:title" content="OMP Session Gateway status — current qualified release and support boundary">
<meta property="og:description" content="Published stable v0.7.4, stock OMP v18.5.1. Exact qualification, provenance, and support boundaries are recorded in the release ledger.">
<meta property="og:image" content="https://alphastorm.github.io/omp-session-gateway/og.png">
<meta property="og:type" content="website">
<meta property="og:url" content="https://alphastorm.github.io/omp-session-gateway/status/">
<meta name="twitter:card" content="summary_large_image">
</head>
<body>
<header class="site">
  <img src="../logo.svg" alt="" aria-hidden="true">
  <a class="brand" href="../">OMP Session Gateway</a>
  <nav>
      <a href="../">Overview</a>
      <a href="../compare/">Compare</a>
      <a href="../status/" aria-current="page">Status</a>
      <a href="../security/">Security</a>
  </nav>
</header>
<main>
<p class="eyebrow">Native OMP integration · release status</p>
<h1>Stable v0.7.4</h1>
<p class="lede"><strong>Works with stock OMP 18.1.20+.</strong> No OMP fork, custom build, or
gateway-specific OMP plugin. The gateway remains a separate private directory and launch broker;
setup still requires <code>collab.autoStart</code>, Bun 1.4.0, and Tailscale Serve.
<strong>v0.7.4</strong> was promoted from <code>v0.7.4-prealpha.1</code>;
stable publication and the separate published-byte Studio/Pixel smoke passed. Qualification applies to the exact combinations below; supported platform families
are tested in CI (first row). Neither covers every later OMP version or an arbitrary build from <code>main</code>.</p>
<table>
<tr><th>Claim</th><th>Current</th></tr>
<tr><td>Supported platforms (CI-tested)</td><td>Linux, macOS, and Windows hosts; Chrome and Chromium, Edge through Chromium, Firefox, Safari/WebKit, and Android; iPhone and iPad as a WebKit browser, emulated in CI. Tested on every change by <code>portable-source</code>, <code>browser-core</code>, <code>browser-notifications</code> and <code>windows-service-lifecycle</code>, and daily by the stock-OMP canaries on Linux and Windows. Supported is not qualified; see the <a href="https://github.com/alphastorm/omp-session-gateway/blob/main/docs/COMPATIBILITY.md#platforms-and-browsers">platform matrix</a>.</td></tr>
<tr><td>Stable publication</td><td><a
href="https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.4">Stable v0.7.4</a> (source
39e3d57232f4b3e09ffe9d8a61b409ee0f01762b, archive SHA-256
80525ced892fee94b902cc2c486cb2e6b9943121d78910b61adf14faef10efe3) was published 2026-10-03T19:02:03Z by
signed-release.yml <a href="https://github.com/alphastorm/omp-session-gateway/actions/runs/37146354037">run
37146354037</a> and is GitHub Latest. Its signed annotated tag, archive attestation verification, and byte-for-byte
local stable-build reproduction are recorded in the release ledger. Published v0.7.3 remains the predecessor. There are
no gateway runtime fixes since v0.7.3; the engineering baseline moves to stock OMP v18.5.1. Exact source, digest, and
all thirteen lanes are recorded in the <a
href="https://github.com/alphastorm/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md">release ledger</a>.</td></tr>
<tr><td>Signed qualification candidate</td><td><a href="https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.4-prealpha.1">v0.7.4-prealpha.1</a>; source <code>dcfa0b32503c</code>, archive <code>71399ede…043b00</code>. Signed tag, checksums, three GitHub attestations and three Sigstore bundles passed; published v0.7.3 verified the same way.</td></tr>
<tr><td>OMP prerequisite / exact qualified baseline</td><td>Stock mainline <code>&gt;= 18.1.20</code>; stock OMP v18.5.1 built from source, <a href="https://github.com/can1357/oh-my-pi/commit/d0cc52397dc2a68d39cba49b0009b9e50ffd643e"><code>d0cc52397dc2</code></a>, Bun <code>1.4.0</code>. No gateway-specific OMP build or publisher credential; embedded client and wire pin remain v18.4.2.</td></tr>
<tr><td>Qualified Linux host</td><td>The Debian lane passed against the candidate archive: <a href="https://github.com/alphastorm/omp-session-gateway/actions/runs/37142569203">run 37142569203</a>. The receipt export does not enumerate OS/kernel versions or migration/recovery invariant counts.</td></tr>
<tr><td>Qualified Mac host</td><td>Virtualization.framework guest, VirtualMac2,1, macOS 27.0 arm64, hosted on the Mac Studio; orchestrated from the Studio's operator account; native addon <code>4e707d5c7a44</code>; doctor 18/18, rollback 23/23, guest reboot and readiness preservation. Historical v0.7.2 Mac17,14 evidence remains unchanged in the release ledger.</td></tr>
<tr><td>Qualified Windows host</td><td>Windows build 26100, x86-64, on a disposable VM with 4 CPUs and 8,186 MiB
reported memory. As Administrator, the candidate installed over published v0.7.3 with stock OMP v18.5.1 built from
source. A real reboot passed 3 pre-login samples over 60,738 ms, with automatic start 63,509 ms after interactive logon.
Doctor passed 15/18, with only the tagged node's identityAllowed, pwa, and sessionHealth false. The named pipe published
at generation 1, View and Control returned 200, stale generations 409, all no-store. The Pixel accepted the user
identity, with View read-only, Control writable, the prompt accepted, and the return to directory. Revocation, readiness
rotation, history-selected rollback, restoration, and uninstall passed with configuration and readiness preserved. A
fresh standard-account install, without Administrator membership or SeSecurityPrivilege, passed a real reboot with 3
pre-login samples over 46,381 ms, automatic start 32,076 ms after that account's logon, doctor 15/18, readiness
rotation, and uninstall, preserving configuration and readiness. The VM and firewall were destroyed, its tailnet node
and access vault removed. The claim is interactive logon, not boot.</td></tr>
<tr><td>Qualified core client</td><td>Pixel 10 Pro, Android 17 build CP3A.260905.009, Chrome 154.0.8037.126; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 6,697 ms, Airplane 3,606 ms, Doze 122 ms; all seven forbidden capability sinks detectable and clean. Physical Android acceptance and background Push both ran on the Pixel 10 Pro.</td></tr>
<tr><td>Qualified background Web Push</td><td>Pixel 10 Pro, Android 17, Chrome 154.0.8037.126, installed WebAPK:
Private, Session, and Preview lock-screen delivery in 1,653, 1,946, and 1,928 ms respectively, each a single
notification with matching detail; tap to current Control, stop tap to View only after two known-busy polls,
stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation,
lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery. Triage passed FIFO, hold/advance,
held-notification close, pending retention, requeue, all-held, stale-hold release, undo/expiry, attention restoration,
and show-all with zero mutations. Resolved, rearmed, replaced, expired, and replayed stale taps were scrubbed without a
launch. Force-stop delivered_while_force_stopped and Doze delivered_after_doze_exit are observed variants, never
delivery guarantees; ten forbidden sinks detectable and clean. Device, browser, and fixture restored.</td></tr>
<tr><td>Qualified cloud browsers</td><td>TestingBot real devices through tunnel 4.9: iPhone 17 Pro Max (iOS 26.6, Safari 26.6), iPad (9th generation, iPadOS 26.6, Safari 26.6), and Galaxy S25 (SM-S931B, Android 15.0.0, Chrome 149.0.7827.159). Each matched the candidate app asset, with View read-only, Control writable, prompt accepted, return to directory, and seven detectable clean sinks. Tunnel refusals were 19, 24, and 13 respectively. All three vendor records exposed no links or media. Cloud cleanup restored.</td></tr>
<tr><td>Qualified iPhone background alerts</td><td>The iPhone Home Screen app enabled alerts; its subscription omitted expirationTime on web.push.apple.com. Delivery took 7,989 ms; the tap opened current Control with a scrubbed address, and alerts were disabled afterwards. This is not a lock-screen presentation claim.</td></tr>
<tr><td>Remote path</td><td>Tailscale Serve over tailnet HTTPS, TUN-mode client, Funnel disabled. The Windows receipt records TUN mode, Funnel off, loopback-only exposure and Pixel identity acceptance.</td></tr>
<tr><td>Fresh relay check</td><td>1,800 seconds, 2026-10-03T18:12:19.444Z–18:42:19.460Z; two transitions, final phase live</td></tr>
<tr><td>OMP publication and revocation</td><td>stock OMP v18.5.1 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked. New-generation and fork transitions kept the instance, advanced generation by 1, rejected stale launches, and each allowed two live launches; fork used two synthetic messages. Resume created a new instance at generation 1 with the same label, two live launches, and two revocations; all launches were no-store.</td></tr>
<tr><td>Migration/rollback predecessor</td><td>Published <code>v0.7.3</code>, mainline. Guest Mac rollback passed 23/23 invariants; Windows history-selected predecessor restoration passed. Both versions embed the same OMP 18.4.2 client and wire pin; there are no gateway runtime fixes to undo. Gateway rollback does not switch OMP.</td></tr>
<tr><td>Published-byte local/Pixel smoke</td><td>Passed on the first attempt, 19:03:40Z–19:07:17Z, tooling at the tag
commit 39e3d57, on the Studio operator account at the Studio's own tailnet origin with the attached Pixel 10 Pro. The
gateway upgraded from v0.7.3 (installed: true) with configPreserved: true, readinessTokenPreserved: true, doctorChecks:
18; tailscaleServe changed: false, unrelatedMappingsPreserved: true. --rebuild-omp installed Bun's global stock OMP
18.5.1, binary SHA-256 fc62b280c50923f779e9af14e0ba12d24cbf3db6b2757106a8ad127b3a3274a9, matching the candidate
engineering baseline. Asset /assets/app.5c4a35b3f50f.js; View read-only, Control writable, capability sinks clean,
same-page recovery and installed WebAPK passed. Gateway, mainline OMP, and WebAPK were left installed. Status: active,
ready, not diverged; active/service version 0.7.4-9a9fd8f2c4d0. Retained runtimes: 0.7.2-0e6104d6ee0b,
0.7.3-11c3cc5ce86f, and 0.7.4-9a9fd8f2c4d0. The smoke does not expand candidate qualification.</td></tr>
</table>
<h2>Known limits — part of the claim</h2>
<ul>
<li><strong>The Mac row is a guest, not bare-metal qualification.</strong> The guest does not exercise physical firmware, FileVault unlock, Secure Boot, power loss, physical sleep/wake, or physical device drivers (ADR-033); guest reboot and console-login recovery do not qualify a bare-metal Mac or startup before login.</li>
<li><strong>TUN mode is mandatory.</strong> With userspace-networking <code>tailscaled</code> every tailnet peer arrives as a loopback peer, and the gateway fails closed rather than believing an identity header.</li>
<li><strong>Never enable Tailscale Funnel.</strong> There is no supported public-Internet path.</li>
<li><strong>Android radio transitions</strong> can wedge Chrome's process-wide network stack while Android stays healthy; the PWA retries and, after 45 s of visible failure, opens force-stop/reopen help.</li>
<li><strong>Relay assurance is 30 minutes, not eight hours.</strong> The founder explicitly replaced the eight-hour gate with this fresh check, as for v0.4.1 and v0.4.0. Eight-hour endurance was not rerun or claimed; residual prolonged-operation risk is accepted. No bounded-memory-growth claim is made.</li>
<li><strong>Attention and lifecycle scope</strong> is limited to the recorded retained-Mac new-generation/fork/resume and Pixel triage/stale-tap scenarios, not arbitrary behavior on every platform. New media qualification remains outside this claim. Background Web Push is qualified in full only on the Pixel, with force-stop and Doze as observed variants, never delivery guarantees.</li>
<li><strong>Cloud devices are qualified in the browser.</strong> The export does not identify the tunnel host or observed Serve identity. The iPhone receipt proves Home Screen alert delivery and a Control tap, not lock-screen presentation; lock, Airplane, Doze, force-stop and cellular behavior stay Pixel-only.</li>
<li><strong>Windows is qualified at the recorded x86-64 build, started at interactive logon, not at boot.</strong> A fresh standard-account install passed, but its upgrade and rollback are not qualified; the lane runs those journeys as Administrator. Other Windows versions remain supported and CI-tested, not qualified by this receipt.</li>
<li><strong>In v0.5.0 and earlier, an update can close a page in use:</strong> on the first visit after a gateway upgrade, the new service worker's activation can navigate a pending launch or an open View/Control page back to the directory, because Chromium reports each page's creation URL. The first post-release View/Control smoke failures, including v0.4.0's return to the directory after View, match this navigation. The v0.5.1 fix never navigates from the worker; see the release ledger.</li>
<li><strong>Untrusted local accounts</strong> are out of scope: a direct loopback caller can forge non-cryptographic identity headers on a shared shell host.</li>
<li><strong>Portal Tunnel and self-hosted or proxied relays</strong> are unsupported; the gateway keeps OMP's existing end-to-end-encrypted relay.</li>
</ul>
<p>Machine-readable truth:
<a href="https://github.com/alphastorm/omp-session-gateway/blob/main/STABLE_RELEASE.lock.json">stable release lock</a> ·
<a href="https://github.com/alphastorm/omp-session-gateway/blob/main/UPSTREAM.lock.json">upstream lock</a> ·
<a href="https://github.com/alphastorm/omp-session-gateway/blob/main/docs/COMPATIBILITY.md">compatibility matrix</a> ·
<a href="https://github.com/alphastorm/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md">release ledger</a> (authoritative where they disagree)</p>
<p class="verified">The <code>v0.7.4-prealpha.1</code> campaign on 2026-10-03, 17:59:22Z–18:50:09Z, ran from the Studio's operator account and passed all thirteen lanes on their first attempt. Final cleanup measured zero gateway processes, zero listeners, and zero live OMP hosts; Windows resources were removed, and Push and cloud cleanup passed. A clean stable-channel build of the approval tree matched all <strong>46 non-metadata candidate files</strong>. Stable publication succeeded; the separate published-byte smoke passed on its first attempt on the Studio.</p>
````

</details>

<details>
<summary>Original changed excerpt: docs/ANDROID.md</summary>

````markdown
The v0.7.4 campaign qualified these phases only for its recorded candidate and devices. Each
later candidate must pass them again on its exact signed bytes; historical evidence does not
transfer. The candidate acceptance checklist is in
[ATTENTION_SPEC.md](ATTENTION_SPEC.md#specialized-triage-and-delayed-tap-acceptance--qualification-pending).
````

</details>

<details>
<summary>Original changed excerpt: docs/ATTENTION_SPEC.md</summary>

````markdown
and before `force_stop_verified`. The v0.7.4 campaign qualified them for its recorded candidate
and devices; each later candidate must pass them again on its exact signed bytes.
On 2026-10-01, a development run of the whole lane passed every phase,
these two included, with no re-arm, and restored the phone. It ran against the installed v0.7.1
gateway with stock OMP 18.4.8 fixtures on the Pixel 10 Pro, Android 17, Chrome `154.0.8037.57`.
That development run is tested evidence ([ANDROID.md](ANDROID.md#physical-background-push-lane)).
The boxes below stay unchecked because every candidate requalifies these phases; the v0.7.4
qualification is recorded in the ledger.
````

</details>

<details>
<summary>Original changed excerpt: docs/LIFECYCLE_BRANCH_RESUME.md</summary>

````markdown
the v0.7.4 qualification stays bound to its recorded candidate and hosts. Each later campaign
must pass these transitions again on its exact signed candidate before its matrix is qualified.
See the [status vocabulary](COMPATIBILITY.md#status-vocabulary) and
[release ledger](RELEASE_STATUS.md).
````

</details>

## Engineering baseline v18.5.1 — canary evidence only

On 2026-10-03, [canary run 37140425389](https://github.com/alphastorm/omp-session-gateway/actions/runs/37140425389)
(gateway `main` at `1b6f0e6`) passed all ten Linux stages and all seven supported Windows stages
against stock OMP v18.5.1, in 17,331 ms and 14,941 ms, both with `discoveryFileRemoved: false`.
Windows intentionally skipped `new-generation`, `fork`, and `branch-rewind`. The source pin is
`d0cc52397dc2a68d39cba49b0009b9e50ffd643e`, tree `f80f979c55f14c2e097b1d83e2f37ade2fa44ce4`.
`scripts/upstream-pins.ts` measured the Darwin arm64 and Windows x64 native hashes from official
npm tarballs after verifying registry integrity; run against v18.4.12, it reproduced every pin
#351 measured by hand. The embedded client stays at v18.4.2.

v18.5.1 is the first release with upstream retry fix can1357/oh-my-pi#14112, which removes the
trigger #343 identified. A throwaway macOS 27 arm64 tracer under Bun 1.4.2 refused each host's
first relay connection and started a local relay only after the host showed
`Collab auto-start failed`: stock 18.5.1 published generation 1 with Control access 1,007 ms after
the relay started, while stock 18.5.0 never published in the following 60 seconds. No candidate,
campaign, or new platform qualification is claimed; the published matrix below is unchanged.

## Mainline v0.7.3 — published stable

**Updated:** 2026-10-03. [v0.7.3](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.3)
was published at **2026-10-02T23:27:30Z** and is GitHub Latest, with six assets. Signed release workflow
[37077558898](https://github.com/alphastorm/omp-session-gateway/actions/runs/37077558898)
(`signed-release.yml`) succeeded. The signed annotated tag `v0.7.3` points to the stable source below.
The assets are `omp-session-gateway-0.7.3-bun.tar`, its `.sigstore.json`,
`omp-session-gateway-0.7.3.spdx.json`, its `.sigstore.json`, `SHA256SUMS`, and
`SHA256SUMS.sigstore.json`. GitHub attestation verification passed for the archive; the subjects
are `SHA256SUMS`, the archive, and the SPDX. A local `OMP_RELEASE_CHANNEL=stable bun run release:build`
of the tag reproduced the published archive digest byte-for-byte.

**Stable source:** `5589ae1ac1ebe687e25886ef30ee1683cb0b2502` (merge of approve PR #357).<br>
**Stable archive SHA-256:** `aa993a13a0f3d9fb479fd75f4733b25fed8fd20cb631bdce2599507a3d6f4cf1`.

The published-byte Studio/Pixel smoke passed on its **fourth attempt**; see below.

**Candidate:** [v0.7.3-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.3-prealpha.1).<br>
**Source:** `7a5f988d980e7f9200ce2c66b43cc85acbc21033`.<br>
**Archive SHA-256:** `ff0f98f35022b3017972f47ff5fc3f5c009890ffdf59e2cfd64979b8fd351e17`.<br>
**Predecessor:** published `v0.7.2`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v073-predecessor-compatibility).

The candidate carries no gateway runtime fixes since v0.7.2; the apps/packages changes are release
version bumps only. The OMP engineering baseline moves to stock OMP v18.4.12 (#351), built from
source at `7318a70cf4ed04133366884d2723f72d9d490a15`; the embedded client and its v18.4.2 wire
pin remain unchanged. The fixes between prepare and approve (#353, #355, #356) change qualification
scripts, not the shipped runtime. This campaign qualifies the Virtualization.framework guest
(VirtualMac2,1), not its physical host. Historical v0.7.2 Mac17,14 rows remain unchanged.

### Candidate evidence — 2026-10-02

All thirteen lanes passed in one resumed campaign, orchestrator
`3043215302c09b2dad42954621f54a9f974dea97`, 19:45:09Z–23:00:26Z. They did not all pass on their first
attempt: artifacts 6, macos 2, ompPublication 4, androidPush 4, androidPushCleanup 5, and cleanup 6;
the other seven lanes each passed on attempt 1. Cleanup lanes are enumerated separately below.
The client split is physical Android acceptance on a Pixel 8 Pro; background Push on a Pixel 10 Pro.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; predecessor v0.7.2 verified the same way |
| Debian | [37056255113](https://github.com/alphastorm/omp-session-gateway/actions/runs/37056255113) succeeded against the candidate archive. The receipt export records the successful run, not its OS/kernel versions or migration/recovery invariant count |
| Mac | Virtualization.framework guest, VirtualMac2,1, macOS 27.0 arm64, hosted on the Mac Studio; orchestrated from the Studio's operator account; stock OMP v18.4.12 built from source with native addon `209ffc607c67`; doctor 18/18, rollback 23/23, changed guest reboot epoch and preserved readiness |
| Windows | Windows build 26100, x86-64, on a disposable VM with 4 CPUs and 8,186 MiB reported memory. As Administrator, the candidate installed over published v0.7.2 with stock OMP v18.4.12 built from source. A real reboot passed 3 pre-login samples over 64,917 ms, with automatic start 68,710 ms after interactive logon. Doctor passed 15/18, with only the tagged node's identityAllowed, pwa, and sessionHealth false. The named pipe published at generation 1, View and Control returned 200, stale generations 409, all no-store. The Pixel accepted the user identity, with View read-only, Control writable, the prompt accepted, and the return to directory. Revocation, readiness rotation, history-selected rollback, restoration, and uninstall passed with configuration and readiness preserved. A fresh standard-account install, without Administrator membership or SeSecurityPrivilege, passed a real reboot with 3 pre-login samples over 60,724 ms, automatic start 42,479 ms after that account's logon, doctor 15/18, readiness rotation, and uninstall, preserving configuration and readiness |
| OMP publication | stock OMP v18.4.12 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked. New-generation and fork transitions kept the instance, advanced generation by 1, rejected stale launches, and each allowed two live launches; fork used two synthetic messages. Resume created a new instance at generation 1 with the same label, two live launches, and two revocations; all launches were no-store |
| Android | Pixel 8 Pro, Android 17 build CP3A.260905.009, Chrome 154.0.8037.92; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 7,177 ms, Airplane 8,371 ms, Doze 228 ms; all seven forbidden capability sinks detectable and clean |
| Background Push | Pixel 10 Pro, Android 17, Chrome 154.0.8037.57, installed WebAPK: Private, Session, and Preview lock-screen delivery in 2,945, 1,884, and 3,003 ms respectively, each a single notification with matching detail; tap to current Control, stop tap to View only after two known-busy polls, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery. Triage passed FIFO, hold/advance, held-notification close, pending retention, requeue, all-held, stale-hold release, undo/expiry, attention restoration, and show-all with zero mutations. Resolved, rearmed, replaced, expired, and replayed stale taps were scrubbed without a launch. Force-stop delivered_while_force_stopped and Doze delivered_after_doze_exit are observed variants, never delivery guarantees; ten forbidden sinks detectable and clean |
| Push cleanup | device, browser, and fixture restored |
| Device cloud | TestingBot real devices through tunnel 4.9: iPhone 17 Pro Max (iOS 26.6, Safari 26.6), iPad (9th generation, iPadOS 26.6, Safari 26.6), and Galaxy S24 (SM-S921B, Android 14.0.0, Chrome 147.0.7727.111). Each matched the candidate app asset, with View read-only, Control writable, prompt accepted, return to directory, and seven detectable clean sinks. Tunnel refusals were 18, 39, and 29 respectively. All three vendor records exposed no links or media. The iPhone Home Screen app enabled alerts; its subscription omitted expirationTime on web.push.apple.com. Delivery took 3,841 ms; the tap opened current Control with a scrubbed address, and alerts were disabled afterwards. This is not a lock-screen presentation claim |
| Device-cloud cleanup | restored |
| Relay | 1,800 seconds, 2026-10-02T20:28:08.005Z–20:58:08.019Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts |
| Windows cleanup | zero instances and firewalls remaining; tailnet node deleted and access vault removed |

**Attempt history:** the campaign was resumed after equipment and qualification-tooling failures,
not gateway runtime fixes. The Mac reboot's SSH session hung; #353 detached the reboot before the
recorded orchestrator commit. The guest then hit ENOSPC during the mainline OMP build, and its disk
was grown from 50 to 100 GB. A transient git clone failure in that build lane was made explicit by
#355 afterwards. Push could not satisfy `cellular_path_unavailable` on the first phone, the
Pixel 8 Pro without cellular service; the campaign finished Push on the Pixel 10 Pro with Chrome
154. WebAPK setup required #356's Chrome-menu scrolling. One Push attempt refused multiple pages
for the Push origin after equipment setup left extra tabs; the device was restored and the lane
passed. These failed attempts do not constitute qualification evidence; the attempt counts above
are the receipt's resumed-campaign totals, including cleanup.

**Runtime equivalence gate:** the clean stable-channel approval build must match every candidate
archive member by path, mode, and bytes after verifying the candidate digest. Only the existing
workflow exclusions apply: release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json, and
schemas/stable-release.schema.json. The approval PR records the release:compare result.

**Assurance scope:** The guest does not exercise physical firmware, FileVault unlock, Secure Boot, power loss, physical sleep/wake, or physical device drivers (ADR-033); guest reboot and console-login recovery do not qualify a bare-metal Mac or startup before login.
The guest exercises the macOS kernel, launchd, loginwindow, per-user LaunchAgent, native addon,
filesystem, TUN interface, and guest reboot. Physical Android and cloud-device evidence is separate.
A fresh 1,800-second relay check replaces the eight-hour gate; eight-hour endurance and bounded
memory growth are not claimed. Windows is limited to the recorded x86-64 build at interactive
logon; upgrade, rollback, OMP, and Pixel journeys ran as Administrator, while the standard-account
claim is fresh installation, reboot/logon start, doctor, rotation, and uninstall. The lifecycle
and Push triage/stale-tap results cover the recorded scenarios, not arbitrary behavior on every
platform. Force-stop and Doze are observed variants, not delivery guarantees. The iPhone receipt
proves Home Screen delivery and a Control tap, not lock-screen presentation; lock, Airplane, Doze,
force-stop, and cellular behavior stay Pixel-only. The export does not identify the cloud tunnel's
host or observed Serve identity. Desktop Safari and broader host/browser combinations remain
unqualified. Every other release gate stays required.

### Published-byte Studio/Pixel verification

The founder's 2026-10-02 decision to "move everything off the MBP" moved this smoke to **the Studio**,
from the Studio operator account, with the gateway at the Studio's own tailnet origin: the first
published-byte smoke off the workstation. That account became tailscaled's operator with one
founder sudo. The verified published predecessor v0.7.2 (archive SHA-256
`98bb3aba1338ee0f0f53076b5fd95c474cd2d9f71981599c148a898dfa572f6a`) was installed under that account
at the Studio origin; Tailscale Serve mapped that origin's HTTPS endpoint to loopback port 4317.
The Pixel 10 Pro, attached to the Studio, already held the OMP Sessions WebAPK for that origin
from the first Studio campaign. The smoke requires an existing installed gateway and Serve
configuration because it is an upgrade smoke; install the published predecessor first on a fresh
host. The smoke installs Bun's global stock OMP itself.

The first `smoke:release` invocation, at **23:34Z** on 2026-10-02, failed before any change:
`bun pm bin --global` fails on a host that has never run `bun add --global`.
[PR #358](https://github.com/alphastorm/omp-session-gateway/pull/358) fixed that tooling failure.
The second invocation, at **23:44Z**, failed at admission because the host had no existing gateway
configuration; the upgrade smoke requires an existing Tailscale Serve configuration. Published
predecessor v0.7.2 was then installed as described above.
The third invocation, at **23:51Z**, upgraded the gateway to `0.7.3-11c3cc5ce86f` but failed its
doctor with `compatibility: false`: the selected stock OMP 18.4.12 in Bun's global bin was not on
the operator PATH. [PR #359](https://github.com/alphastorm/omp-session-gateway/pull/359) fixed the
tooling by placing the selected OMP's directory on PATH.

The fourth invocation, **00:00:03Z–00:04:14Z** on 2026-10-03, with tooling at `b7f456e`, **passed**:
`bun run smoke:release -- --tag v0.7.3 --archive-sha256 aa993a13a0f3d9fb479fd75f4733b25fed8fd20cb631bdce2599507a3d6f4cf1`.
Its result JSON recorded `sourceCommit: 5589ae1ac1ebe687e25886ef30ee1683cb0b2502` and
`appAsset: /assets/app.5c4a35b3f50f.js`. The gateway result was `installed: false` because attempt 3
had already upgraded it, with `configPreserved: true`, `readinessTokenPreserved: true`, and
`doctorChecks: 18`. Tailscale Serve recorded `changed: false` and
`unrelatedMappingsPreserved: true`.
The smoke selected Bun's global stock OMP **18.4.12**, installed by its own
`bun add --global --exact @oh-my-pi/pi-coding-agent@18.4.12`. The passing result recorded
`installed: false` because attempt 2 had installed it; its `binarySha256` was
`d659505080c80a091524de1335caccdb815e05367bd825048cda4a0e98d8b7a0`.
Unlike v0.7.2's smoke against stock OMP 18.1.20, this matches the candidate evidence's engineering
baseline, while the candidate used stock OMP v18.4.12 built from source.

The retained runtime directories on the Studio operator account were `0.7.2-0e6104d6ee0b`
(the published predecessor) and `0.7.3-11c3cc5ce86f`.

On the Pixel 10 Pro, the Android result recorded `viewReadOnly: true`, `controlWritable: true`,
`capabilitySinksClean: true`, `samePageRecovery: true`, and `installedWebApk: true`.
The `leaveInstalled` result recorded `gateway: true`, `mainlineOmp: true`, and `webApk: true`.

Afterwards, `status` reported active, ready, and not diverged, with active and service versions
`0.7.3-11c3cc5ce86f`. The smoke does not expand the exact candidate host/client matrix or turn
the guest qualification into bare-metal qualification. Windows, cloud browsers, and background
Push rest on their respective candidate lanes above.

## Engineering baseline v18.4.12 — canary evidence only

On 2026-10-02, [canary run 37040958377](https://github.com/alphastorm/omp-session-gateway/actions/runs/37040958377)
passed all ten Linux stages and all seven supported Windows stages against stock OMP v18.4.12.
Windows intentionally skipped `new-generation`, `fork`, and `branch-rewind`. The source pin
is `7318a70cf4ed04133366884d2723f72d9d490a15`, tree `d804bc6bff03bb96057dd46f3bf6ae0479e7c649`.
Darwin arm64 and Windows x64 native hashes were measured from official npm artifacts, with
registry integrity verified. The embedded client stays at v18.4.2. No candidate, campaign,
macOS execution, or new platform qualification is claimed; the published matrix below is unchanged.
Issue #343 remains open because a green sample does not prove the pending upstream retry fix.

## Mainline v0.7.2 — published stable

**Updated:** 2026-10-02. [v0.7.2](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.2)
was published at **12:37:44 UTC** and is GitHub Latest, with six assets. Signed release workflow
[37007713319](https://github.com/alphastorm/omp-session-gateway/actions/runs/37007713319) succeeded.
The published archive matches the clean local `OMP_RELEASE_CHANNEL=stable` build of the tag;
`gh release verify` passed, `gh release verify-asset` passed for all six assets, and
`SHA256SUMS` verified.

**Stable source:** `af81ac2b90292bd62212019651f4d597bd2645fc` (merge of #345).<br>
**Stable archive SHA-256:** `98bb3aba1338ee0f0f53076b5fd95c474cd2d9f71981599c148a898dfa572f6a`.

The published-byte workstation/Pixel smoke passed on its **second attempt**; see below.

**Candidate:** [v0.7.2-prealpha.2](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.2-prealpha.2).<br>
**Source:** `60f7e10362c8541c65509843e9de854db75d1dad`.<br>
**Archive SHA-256:** `7ebaf9b43d7a2248f394476c7a3ee109a31d220e9714dbd5ad60286eac841922`.<br>
**Predecessor:** published `v0.7.1`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v072-predecessor-compatibility).

The candidate carries no gateway runtime fixes since v0.7.1. The OMP engineering baseline is
stock OMP v18.4.8 built from source. Its collaboration host source and embedded client are
byte-identical to v18.4.2; the embedded client retains its v18.4.2 provenance and wire pin.
This is the first campaign on the Mac Studio (Mac17,14), reached over SSH as `gwqual`, rather
than the previous Scaleway Mac14,3. Historical receipts remain evidence for their original hosts.
The fixes between prepare and approve (#341, #342, #344) change only qualification scripts and
documentation, not the shipped runtime.

### Candidate evidence — 2026-10-02

All thirteen lanes come from one campaign run by orchestrator
`5e167f4ea11060c1563a5bdd84587fb3d76f311e`, 11:32:08Z–12:20:54Z, where each passed on its first
attempt. Cleanup lanes are included with their corresponding evidence below.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; predecessor v0.7.1 verified the same way |
| Debian | [37001605048](https://github.com/alphastorm/omp-session-gateway/actions/runs/37001605048) succeeded against the candidate archive; stock OMP v18.4.8 built from source. The receipt export records the successful run, not its OS/kernel versions or migration/recovery invariant count |
| Mac | the Mac Studio, Mac17,14, macOS 27.0.1 arm64; stock OMP v18.4.8 built from source with native addon `b9a905e063b3`; doctor 18/18, rollback 23/23 |
| Windows | Windows build 26100, x86-64, on a disposable VM with 4 CPUs and 8,186 MiB reported memory. As Administrator, the candidate installed over published v0.7.1 with stock OMP v18.4.8 built from source. A real reboot passed three pre-login samples over 61,655 ms, with automatic start 66,309 ms after interactive logon. Doctor passed 15/18, with only the tagged node's `identityAllowed`, `pwa`, and `sessionHealth` false. The named pipe published at generation 1, View and Control returned `200`, stale generations `409`, all `no-store`. The Pixel accepted the user identity, with View read-only, Control writable, the prompt accepted, and the return to directory. Revocation, readiness rotation, history-selected rollback, restoration, and uninstall passed with configuration and readiness preserved. A fresh standard-account install, without Administrator membership or `SeSecurityPrivilege`, passed a real reboot with three pre-login samples over 46,826 ms, automatic start 34,368 ms after that account's logon, doctor 15/18, readiness rotation, and uninstall, preserving configuration and readiness |
| OMP publication | stock v18.4.8 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked. New-generation and fork transitions kept the instance, advanced generation by 1, rejected stale launches, and each allowed two live launches; fork used two synthetic messages. Resume created a new instance at generation 1 with the same label, two live launches, and two revocations; all launches were no-store |
| Android | Pixel 10 Pro, Android 17 CP3A.260905.009, Chrome 154.0.8037.57; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 6,584 ms, Airplane 3,671 ms, Doze 301 ms |
| Background Push | Private, Session, and Preview delivery on the lock screen in 1,349, 1,555, and 1,561 ms respectively, each a single notification with matching detail; tap to current Control, stop tap to View only after two known-busy polls, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery. Triage passed FIFO, hold/advance, held-notification close, pending retention, requeue, all-held, stale-hold release, undo/expiry, attention restoration, and show-all with zero mutations. Resolved, rearmed, replaced, expired, and replayed stale taps were scrubbed without a launch. Force-stop `delivered_while_force_stopped` and Doze `delivered_after_doze_exit` are observed variants; ten forbidden sinks detectable and clean; device, browser, and fixture restored |
| Device cloud | TestingBot real devices through tunnel 4.9: iPhone 17 Pro Max (iOS 26.6, Safari 26.6), iPad (9th generation, iPadOS 26.6, Safari 26.6), and Galaxy S25 (`SM-S931B`, Android 15.0.0, Chrome 149.0.7827.159). Each matched the candidate app asset, with View read-only, Control writable, prompt accepted, return to directory, and seven detectable clean sinks. Tunnel refusals were 11, 24, and 26 respectively. The iPhone Home Screen app enabled alerts; its subscription omitted `expirationTime` on `web.push.apple.com`. Delivery took 4,430 ms; the tap opened current Control with a scrubbed address, and alerts were disabled afterwards. All three vendor records exposed no links or media; cloud cleanup restored |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-10-02T11:45:46.097Z–12:15:46.107Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Windows VM and firewall were destroyed, its tailnet node deleted, and its access vault removed; Push and device-cloud cleanup passed |

**Failed attempts before the passing campaign:** v0.7.2-prealpha.1 failed twice in Windows when
the Vultr guest's resolver returned SERVFAIL for `pkgs.tailscale.com`; #341 configured public
resolvers in the guest. The tag was abandoned after reaching its per-tag Windows VM creation cap,
not for a candidate defect. The v0.7.2-prealpha.2 archive is byte-identical to that superseded
archive. Earlier v0.7.2 campaigns also failed in Push on a CDP execution-context race (fixed by
#342), then on a WebAPK chrome-error document after the Mac Studio origin had been unreachable
(fixed by #344: evaluate surfaces page exceptions, and page() reloads a non-origin document).
One run was stopped by hand when the Mac reboot guard refused while a release-worker job ran on
the same host. These failed or stopped attempts are not qualification evidence.

**Development run before the campaign (tested evidence only):** the Push lane ran against this
exact candidate at the workstation origin and passed 17/17 phases. It does not substitute for
the signed-candidate campaign above.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files** by path, mode, and bytes (`bun run release:compare`), after
re-verifying the candidate digest. Only the existing workflow exclusions apply: release-info.json,
SBOM.spdx.json, STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion
tree was identical to the tested tree (`d62c334`), and the published stable archive also matched all
46 non-metadata candidate files.

**Assurance scope:** the campaign ran a fresh 1,800-second relay check in place of the eight-hour
gate. Eight-hour endurance and bounded memory growth are not claimed. Windows qualification is
limited to the recorded x86-64 build at interactive logon, from the Administrator and from a fresh
standard-account install; upgrade, rollback, OMP, and Pixel journeys ran as the Administrator.
Background Web Push is qualified in full only on the Pixel, with force-stop and Doze outcomes as
observed variants. Qualification now includes the recorded retained-Mac lifecycle and Pixel
triage/stale-tap scenarios, not arbitrary attention or branch/resume behavior on every platform.
The cloud browser claim is limited to the exact models and versions above. The iPhone receipt
records Home Screen alert delivery and a Control tap, not lock-screen presentation; lock,
Airplane, Doze, force-stop, and cellular behavior stay Pixel-only. The export does not identify
the cloud tunnel's host or observed Serve identity. Desktop Safari and broader host/browser
combinations remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag and archive digest above,
ran 12:39:27–12:43 UTC and failed at the installed-WebAPK check. Two seconds after launch,
`dumpsys activity` still showed Chrome's browser activity in front after the acceptance lane's
lock/airplane/doze cycles. The WebAPK was installed, and the same launch was the focused standalone
task when sampled a few seconds later. [PR #346](https://github.com/alphastorm/omp-session-gateway/pull/346),
`fix(smoke): wait for the launched WebAPK task instead of sampling once after two seconds`,
corrected the tooling to poll for up to 30 s while still failing closed.

The second invocation from that corrected tooling, 12:47:02–12:50:38 UTC, **passed**:
`bun run smoke:release -- --tag v0.7.2 --archive-sha256 98bb3aba1338ee0f0f53076b5fd95c474cd2d9f71981599c148a898dfa572f6a`.
It verified the published provenance. The gateway result was `installed: false` because the failed
first attempt had already upgraded the workstation to the published bytes, `0.7.2-0e6104d6ee0b`;
the passing run recorded `configPreserved: true`, `readinessTokenPreserved: true`, and
`doctorChecks: 18`. Tailscale Serve was unchanged and unrelated mappings were preserved.
The `omp` on the default PATH is not stock OMP, so the smoke selected Bun's global stock OMP
**18.1.20**, the minimum supported version, and did not reinstall it. Its binary SHA-256 was
`b3718d4e536e6385c4d8a875376d6b728847f32a0d7ec471cde63c767b3c7c2b`.
The candidate evidence above, not this smoke, covers stock OMP v18.4.8 built from source.

The retained runtime directories were `0.7.1-2c4f80b3ccc2`, `0.7.2-0e6104d6ee0b`, and
`0.7.2-737c81e5d92f`. The last is a development install of the candidate archive made earlier
that day for the Push lane's development run. Activation history ends
`…, 0.7.0-ac32668c3851, 0.7.1-2c4f80b3ccc2, 0.7.2-737c81e5d92f, 0.7.2-0e6104d6ee0b`:
plain `rollback` selects the candidate build `0.7.2-737c81e5d92f`, not the published predecessor
`0.7.1-2c4f80b3ccc2`, which is retained one step further back.

On the Pixel 10 Pro, with asset `app.5c4a35b3f50f.js`, View was read-only and Control writable;
the capability-sink, same-page recovery, and installed-WebAPK checks passed. The gateway,
mainline OMP, and WebAPK were left installed.

Afterwards, `status` reported active, ready, and not diverged, with active and service versions
`0.7.2-0e6104d6ee0b`. The smoke does not expand the exact candidate host/client matrix. It runs
on macOS, so it does not exercise Windows; that rests on the Windows evidence above. iPhone,
iPad, and Galaxy browsers rest on the campaign's cloud lane, and background Push on its Pixel lane.

## Mainline v0.7.1 — published stable

**Updated:** 2026-09-30. [v0.7.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.1)
was published at **01:24:01 UTC** and is GitHub Latest, with six assets. Signed release workflow
[36654824053](https://github.com/alphastorm/omp-session-gateway/actions/runs/36654824053) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build of the tag, and
`gh release verify` and `verify-asset` passed for the release and all six assets.

**Stable source:** `2435e0da528375665b2807ca10b0ac3ff543c001`.<br>
**Stable archive SHA-256:** `b1fdda4cab417ce62cc98262d8805cf9581f6a367aa8d948e83af986ab0c54d0`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.7.1-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.1-prealpha.1).<br>
**Source:** `861225c9abd9379bf78ac40febb2d99a6d7bbcb3`.<br>
**Archive SHA-256:** `097d457bbeab931304e132d162c9b2fa7860016ac1dc6b88b9f06ac98427d1af`.<br>
**Predecessor:** published `v0.7.0`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v071-predecessor-compatibility).

The candidate carries three runtime fixes since v0.7.0. A tapped notification is handed to the open
page, which switches in place instead of being reloaded (#327; ADR-017, amended 2026-09-30). A
frozen session-list page releases its live-update stream (#328). The gateway releases event streams
that stop reading (#321). The other changes are qualification tooling (#322–#326) and the first
eight-hour observations (#332), which are tested evidence, not qualification. The OMP engineering
baseline stays v18.4.2; the daily upstream canary passed against stock OMP 18.4.4 on 2026-09-30,
which is compatibility evidence only.

### Candidate evidence — 2026-09-30

All thirteen lanes come from one campaign run by orchestrator
`861225c9abd9379bf78ac40febb2d99a6d7bbcb3`, 00:15:26Z–01:10:13Z, where each passed on its first
attempt.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [36647813108](https://github.com/alphastorm/omp-session-gateway/actions/runs/36647813108); predecessor v0.7.0 verified the same way |
| Debian | [36649552259](https://github.com/alphastorm/omp-session-gateway/actions/runs/36649552259) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; stock OMP v18.4.2 built from source; 83/83 migration/recovery invariants; the droplet, its tailnet node, and its ephemeral SSH key were deleted |
| Mac | Mac14,3, macOS 26.6.1 arm64; stock OMP v18.4.2 built from source with native addon `02135de929e1`; doctor 18/18, rollback 23/23, rotation, and reboot-to-login persistence with the readiness token unchanged |
| Windows | Windows Server 2025 build 26100 on a disposable 4-vCPU/8-GiB VM (`vc2-4c-8gb`). As Administrator, the candidate installed over published v0.7.0 with stock OMP v18.4.2, built from source on the guest. It survived a real reboot (three pre-login samples over 67.7 s) and started automatically 71.7 s after interactive logon. Doctor passed 15/18, with only the tagged node's `identityAllowed`, `pwa`, and `sessionHealth` false. The named pipe published at generation 1, View and Control returned `200`, stale generations `409`, all `no-store`. The Pixel accepted the user identity, with View read-only, Control writable, the prompt accepted, and the return to directory. Revocation, readiness rotation, history-selected rollback, restoration, and uninstall preserved configuration and the readiness credential. Then, on the same VM, a standard local account's token held neither Administrators nor `SeSecurityPrivilege`. The account's fresh install survived a real reboot (three pre-login samples over 50.9 s) and started 30.2 s after the account's logon. Its doctor passed 15/18, rotation changed readiness and kept the configuration, and uninstall kept both |
| OMP publication | stock v18.4.2 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP3A.260905.009, Chrome 154.0.8037.57; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 7,421 ms, Airplane 5,976 ms, Doze 408 ms |
| Background Push | the installed app closed: Private, Session, and Preview delivery on the lock screen in 2.8–3.8 s, each a single notification with matching detail; tap to current Control, stop tap to View only after two known-busy polls, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery; force-stop `delivered_while_force_stopped` and Doze `delivered_after_doze_exit` as observed variants; ten forbidden sinks detectable and clean; device, browser, and fixture restored |
| Device cloud | TestingBot real devices ran through the pinned tunnel 4.9. Its proxy refused every destination but the candidate origin and its `connect-src` sources (24, 31, and 49 refusals). On the iPhone 17 Pro Max (iOS 26.6, Safari 26.6), View was read-only, Control writable, the prompt accepted, and the return to directory worked on the candidate's app bundle. Its Home Screen app enabled alerts with a real tap, and the subscription omitted `expirationTime` on `web.push.apple.com`. An attention alert arrived in 15,966 ms with the app in the background, its tap opened current Control with a scrubbed address, and alerts were then turned off. The iPad (9th generation, iPadOS 26.6, Safari 26.6) and the Galaxy S26 (`SM-S942B`, Android 16.0.0, Chrome 145.0.7632.159) passed the same journey. Each device's seven sinks were detectable and clean, and TestingBot's three test records held no live link, video, or screenshot |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-09-30T00:32:32.439Z–01:02:32.448Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Mac's OMP binary and source removed; the Windows VM, its firewall, and its tailnet node destroyed, and its access vault removed |

**Development run before the campaign (tested evidence only):** the Push lane ran against the
workstation's installed v0.7.0 with the campaign's harness. It passed admission, all three detail
levels, both taps, the stale-generation scrub, the authoritative clear and force-stop, then stopped
at the permission phase: notifications from the workstation's own five live sessions overlapped an
owned phase twice, and the lane fails closed on a repeated foreign post. It restored the device and
released its lease. A device probe then showed that once the lane closes the installed app, no page
or window client for the origin remains, so v0.7.1's in-page tap routing (#327) leaves the lane's
taps on their fresh-window path; the campaign's Push lane passed every tap phase.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files** by path, mode, and bytes (`bun run release:compare`), after
re-verifying the candidate digest. Only the existing workflow exclusions apply: release-info.json,
SBOM.spdx.json, STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion
tree was identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the campaign ran a fresh 1,800-second relay check in place of the eight-hour
gate, as every mainline release has. Eight-hour endurance and bounded memory growth are not
claimed; the first eight-hour observations of v0.7.0 (#332) are tested evidence, not qualification.
Windows is qualified only as Windows Server 2025 x86-64 started at interactive logon, from the
Administrator and from a fresh standard-account install; the lane runs the upgrade, rollback, OMP,
and Pixel journeys as the Administrator. Background Web Push is qualified in full only on the
Pixel, with force-stop and Doze outcomes as observed variants. The cloud devices are qualified in
the browser at the exact models and versions above. The tunnel ran on the workstation, so Serve saw
the workstation's allowlisted login, not a phone's. The iPhone's alert was proven with the device
unlocked and the app in the background, not on the lock screen; lock, Airplane, Doze, force-stop,
and cellular behavior stay Pixel-only. Desktop Safari, specialized attention/branch-resume, and
broader host/browser combinations remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
passed in about four minutes (01:25:45–01:29:44 UTC). It verified the published provenance and
upgraded the installed gateway from `0.7.0-ac32668c3851` to `0.7.1-2c4f80b3ccc2` with the
configuration and readiness token preserved; Tailscale Serve was unchanged and unrelated mappings
were preserved. `doctor` passed 18/18. The `omp` on the default PATH is not stock OMP, so the smoke
selected Bun's global stock OMP 18.1.20, the minimum supported version, and did not reinstall it.
The candidate evidence above, not this smoke, covers the exact OMP 18.4.2.

The install removed the superseded `0.6.2-04bbe8b69b63` runtime and kept `0.7.1-2c4f80b3ccc2`,
`0.7.0-ac32668c3851` and `0.6.3-2e592dd1224d`; activation history records `0.7.0-ac32668c3851` as
the predecessor that plain `rollback` selects.

On the Pixel, with asset `app.5c4a35b3f50f.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.7.1-2c4f80b3ccc2`. The smoke does not expand the exact candidate host/client
matrix. It runs on macOS, so it does not exercise Windows; that rests on the Windows evidence
above. iPhone, iPad, and Galaxy browsers rest on the campaign's cloud lane, and background Push on
its Pixel lane.

## Mainline v0.7.0 — published stable

**Updated:** 2026-09-29. [v0.7.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.0)
was published at **12:55:35 UTC** and is GitHub Latest, with six assets. Signed release workflow
[36571293409](https://github.com/alphastorm/omp-session-gateway/actions/runs/36571293409) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build of the tag, and
`gh release verify` and `verify-asset` passed for the release and all six assets.

**Stable source:** `691e77d1cee1ad994d867a000bc61d56dab43513`.<br>
**Stable archive SHA-256:** `ba182f8bdc47fb3191331f04eb243f66693b625a762978a2c09cf48b3652ddd1`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.7.0-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.7.0-prealpha.1).<br>
**Source:** `53d7629accb7a2c547b244412dcf43180d7a33c9`.<br>
**Archive SHA-256:** `b8488c29e85c86d28e33e1b0dcf669a8a2b1211d06a2770f7596d90b73bfd95f`.<br>
**Predecessor:** published `v0.6.3`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v070-predecessor-compatibility).

The candidate refreshes the embedded collaboration client and the OMP engineering baseline to
published v18.4.2 (#307): upstream's redesigned client surfaces and buffered snapshot publication,
with the gateway's chrome, in-memory capabilities, photo and Ask composer, bounded recovery, and
explicit transcript expansion kept, and OMP's artwork excluded. It also ships React's production
build in the collaboration client (#306; its JavaScript drops from 884 KB to 644 KB), keeps text
fields at 16px on every touch screen so iOS Safari does not zoom into the composer on an iPad or a
landscape phone (#305), and fails closed on Windows when the scheduled task cannot be queried
(#301).

### Candidate evidence — 2026-09-29

Twelve lanes come from the campaign run by orchestrator
`156a6974b0848808d056aa2119a1a02db25845be`, 10:38:02Z–11:26:53Z, where each passed on its first
attempt. That campaign's Windows lane failed while building stock OMP on the guest; the Windows
evidence comes from a one-time maintainer exception, described under **Attempts**.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [36516806998](https://github.com/alphastorm/omp-session-gateway/actions/runs/36516806998); predecessor v0.6.3 verified the same way |
| Debian | [36556876186](https://github.com/alphastorm/omp-session-gateway/actions/runs/36556876186) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; stock OMP v18.4.2 built from source; 83/83 migration/recovery invariants |
| Mac | Mac14,3, macOS 26.6.1 arm64; stock OMP v18.4.2 built from source with native addon `02135de929e1`; doctor 18/18, rollback 23/23, rotation, and reboot-to-login persistence with the readiness token unchanged; neither the tailnet nor the public address gave the backend an HTTP answer |
| Windows | Windows Server 2025 build 26100 on a disposable 4-vCPU/8-GiB VM (`vc2-4c-8gb`), from a development run of the final orchestrator (see the exception below). As Administrator, the candidate installed over published v0.6.3 with stock OMP v18.4.2, built from source on the guest in 673 s. It survived a real reboot (three pre-login samples over 65.7 s) and started automatically 69.2 s after interactive logon. Doctor passed 15/18, with only the tagged node's `identityAllowed`, `pwa`, and `sessionHealth` false. The named pipe published at generation 1, View and Control returned `200`, stale generations `409`, all `no-store`. The Pixel accepted the user identity, with View read-only, Control writable, the prompt accepted, and the return to directory. Revocation, readiness rotation, history-selected rollback, restoration, and uninstall preserved configuration and the readiness credential. Then, on the same VM, a standard local account's token held neither Administrators nor `SeSecurityPrivilege`. After the Administrator signed out of Tailscale and the account joined as a new tagged node, the account's fresh install became ready. It survived a real reboot (three pre-login samples over 61.4 s) and started 41.7 s after the account's logon. Its doctor passed 15/18, rotation changed readiness and kept the configuration, and uninstall kept both |
| OMP publication | stock v18.4.2 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP3A.260905.009, Chrome 154.0.8037.57; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 2,268 ms, Airplane 5,799 ms, Doze 484 ms |
| Background Push | the installed app closed: Private, Session, and Preview delivery on the lock screen in 1.9–4.0 s, each a single notification with matching detail; tap to current Control, stop tap to View only after two known-busy polls, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery; force-stop `delivered_while_force_stopped` and Doze `delivered_after_doze_exit` as observed variants; ten forbidden sinks detectable and clean; device, browser, and fixture restored |
| Device cloud | TestingBot real devices ran through the pinned tunnel 4.9. Its proxy refused every destination but the candidate origin and its `connect-src` sources (9, 27, and 28 refusals). On the iPhone 17 Pro Max (iOS 26.6, Safari 26.6), View was read-only, Control writable, the prompt accepted, and the return to directory worked on the candidate's app bundle. Its Home Screen app enabled alerts with a real tap, and the subscription omitted `expirationTime` on `web.push.apple.com`. An attention alert arrived in 15,549 ms with the app in the background, its tap opened current Control with a scrubbed address, and alerts were then turned off. The iPad (9th generation, iPadOS 26.6, Safari 26.6) and the Galaxy S26 (`SM-S942B`, Android 16.0.0, Chrome 145.0.7632.159) passed the same journey. Each device's seven sinks were detectable and clean, and TestingBot's three test records held no live link, video, or screenshot |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-09-29T10:55:19.772Z–11:25:19.779Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Mac's OMP binary and source removed; each Windows VM, its firewall, and its tailnet node destroyed, and its access vault removed |

**Attempts:** the candidate took three campaigns. The first two failed on the qualification
harness and the operator's network, not the candidate.

1. Orchestrator `52a4216`: the Mac lane's exposure probe misread the operator's carrier network,
   which completed TCP handshakes even to unroutable addresses; the probe now judges exposure by an
   HTTP answer (#310, #311). The Windows lane failed building stock OMP on the guest
   (`bun.exe exit 1`). Development runs of the Windows lane (tested evidence only) then fixed
   status reads that trailed proven readiness on a loaded guest (#312), a DevTools endpoint race on
   the Pixel (#313), and the device journey's match for 18.4.2's read-only placeholder (#314).
2. Orchestrator `12f6612`, with two receipt resumes: the operator's network changed mid-run, and
   then the controller was tethered to the Pixel, whose radio changes in the Push lane cut the
   controller's own network. Windows lost WinRM, and its cleanup waited until the new egress `/32`
   was allowlisted. Qualification now refuses to start while the Pixel is tethering (#315). The
   second resume, on a stable network, found two harness defects: after Airplane mode, Play
   Services opened its push socket on mobile data and held the authoritative clear once Wi-Fi took
   over, and a Vultr listing came back without its array. Mobile data now returns only after Wi-Fi
   validates, and an invalid listing is read again (#316).
3. Orchestrator `156a697`: every lane but Windows passed. Windows again failed building stock OMP
   on the 2-vCPU/4-GiB guest (`omp-build exit 1`), which had failed in two of the three stable
   attempts that reached that step. The lane moved to a 4-vCPU/8-GiB VM, keeps the build's output on
   the guest for inspection, and pins the controller's FreeRDP 3.32.1 after a Homebrew upgrade
   (#317).

**One-time exception (maintainer-approved 2026-09-29):** the Windows row comes from a
development-mode run of the Windows lane rather than from the campaign's own Windows lane. The
development CLI runs the same lane code (`runWindows`) against the same verified candidate and
predecessor; it differs only in keeping a failed VM for repair and in its VM creation cap. The run,
12:07:55Z–12:45:23Z on a fresh VM, recorded no failed or resumed phase. It ran tree
`204b731d936e9ad78b2e87d3c6dc0ca8ddb5ade4`, the tree of `main` at `3431e59` (#317). That commit
differs from the campaign's `156a697` in the Windows lane's guest script, pins, test, and docs, and
in the provider-read retry budget that the orchestrator and the device-cloud lane share: five reads
over about 30 s instead of three over about 6 s. A longer 5xx retry cannot change a read that
succeeded, so the twelve passed lanes would have run identically on the final code. The maintainer
also raised this candidate's Windows VM creation cap. Two development attempts on the final branch
stopped before any product phase, and each led to a fix in #317: the guest's shape check
hard-coded two processors, and Vultr answered 502 to all three reads of a staging lookup. A third,
on `vhp-4c-8gb-amd`, was refused by Vultr (HTTP 400) before any VM existed. None of them is
evidence. The run's teardown destroyed the VM, its firewall, and its tailnet node and removed its
access vault, but reported a harness defect: its OMP stop refused a stored process ID that an
unrelated process held after the lane's reboots. A repeated cleanup then showed a second: it
cannot restore the Pixel once the vault is gone. Neither touches the lane's evidence; zero
`omp-winqual-*` instances, firewall groups, and tailnet nodes remained, and no vault.

**Windows build capacity:** on the 8 GiB VM, stock OMP 18.4.2 built in 673 s (1,197 s in the
earlier 4 GiB development run) and peaked at 4,530 MB committed, Bun at 2,205 MB private, against
a 9,210 MB commit limit with the image's fixed 1,024 MB pagefile. With the same pagefile, a 4 GiB
VM's limit is about 5.1 GB. The two failed builds there left no output, so memory exhaustion is the
likely cause, not an observed one; the guest now keeps that output.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files** by path, mode, and bytes (`bun run release:compare`), after
re-verifying the candidate digest. Only the existing workflow exclusions apply: release-info.json,
SBOM.spdx.json, STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion
tree was identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the campaign ran a fresh 1,800-second relay check in place of the eight-hour
gate, as every mainline release has. Eight-hour endurance and bounded memory growth are not
claimed. Windows is qualified only as Windows Server 2025 x86-64 started at interactive logon, from
the Administrator and from a fresh standard-account install; the lane runs the upgrade, rollback,
OMP, and Pixel journeys as the Administrator. Background Web Push is qualified in full only on the
Pixel, with force-stop and Doze outcomes as observed variants. The cloud devices are qualified in
the browser at the exact models and versions above. The tunnel ran on the workstation, so Serve saw
the workstation's allowlisted login, not a phone's. The iPhone's alert was proven with the device
unlocked and the app in the background, not on the lock screen; lock, Airplane, Doze, force-stop,
and cellular behavior stay Pixel-only. Desktop Safari, specialized attention/branch-resume, and
broader host/browser combinations remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
passed in about four minutes (12:58–13:02 UTC). It verified the published provenance and upgraded
the installed gateway from `0.6.3-2e592dd1224d` to `0.7.0-ac32668c3851` with the configuration and
readiness token preserved; Tailscale Serve was unchanged and unrelated mappings were preserved.
`doctor` passed 18/18. The `omp` on the default PATH is not stock OMP, so the smoke selected Bun's
global stock OMP 18.1.20, the minimum supported version, and did not reinstall it. The candidate
evidence above, not this smoke, covers the exact OMP 18.4.2.

The install removed the superseded `0.6.1-df63aff418ad` runtime and kept `0.7.0-ac32668c3851`,
`0.6.3-2e592dd1224d` and `0.6.2-04bbe8b69b63`; activation history records `0.6.3-2e592dd1224d` as
the predecessor that plain `rollback` selects.

On the Pixel, with asset `app.e8cbcae0cb31.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.7.0-ac32668c3851`. The smoke does not expand the exact candidate host/client
matrix. It runs on macOS, so it does not exercise Windows; that rests on the Windows evidence
above. iPhone, iPad, and Galaxy browsers rest on the campaign's cloud lane, and background Push on
its Pixel lane.

### Post-release eight-hour observations — 2026-09-30

These two runs are **tested evidence**, not qualification. No candidate campaign ran, and the v0.7.0
claims above are unchanged. Both ran on the release workstation (Mac16,5, macOS 27.0 build 26A428,
arm64).

**Default-relay soak, published runtime.**
- Setup: the installed `0.7.0-ac32668c3851` runtime (Bun 1.4.0) and a stock OMP 18.4.2 host (native
  addon `02135de929e1…`, matching `UPSTREAM.lock.json`), started with `collab.autoStart: view` in an
  isolated agent directory. One View client joined over OMP's default relay and ran for the full
  28,800-second window, 14:55:28–22:55:28 UTC. The gateway process did not restart.
- Harness: `scripts/relay-soak.ts` at `bdeca70`, the first revision of #323. It found the gateway
  process from the listening port; the samples match `ps` for the process launchd reports. The merged
  harness requires that PID explicitly.
- Relay: 12 phase transitions (the 150-second diagnostic recorded 2; the harness does not timestamp
  them), final phase `live`, exit 0.
- Gateway process, 482 samples at about one a minute:
  - Resident memory was 40,320 KiB at the start and 51,104 KiB at the end, with a minimum of 35,200
    and a maximum of 51,312. Hourly means stayed between 44,074 and 49,750 KiB.
  - The least-squares trend was −630 KiB/h over the window: −321 KiB/h in its first half and
    −959 KiB/h in its second.
  - CPU inside the window was 76.63 s, about 0.27% of one core.
- Concurrent load: the gateway was not isolated. Throughout the window it also served the
  maintainer's other published sessions and the Pixel's installed app. Six short test runs also used
  it, ending at 16:05, 16:42, 16:44, 16:45, 17:11 and 17:15 UTC: three physical Android acceptance
  runs of about two minutes each, and three relay-soak reproductions of 30–45 s.

**Synthetic endurance, v0.7.0 runtime source.**
- Setup: `bun run qualify:endurance` at `19bbd19`, whose harness is byte-identical to merged #326.
  It ran the working tree's gateway with Bun 1.4.0, using private roots and loopback port 4319. That
  tree's `apps/` and `packages/` match tag v0.7.0 exactly.
- Load: 50 synthetic hosts, 4 SSE subscribers and 28,800 s, with a metadata change every 30 s, a
  host churn every 120 s, a View launch every 4 s, and discovery every 10 s.
- Not covered: the relay, the phone and Tailscale are outside this run.
- Concurrent load: the workstation was not idle. The relay soak above ran throughout. Repeated
  local test suites and builds ran between roughly 16:00 and 18:40 UTC, and so did the physical
  Android runs listed above. Two Pixel checks each ran a second loopback gateway: a tap probe with
  four synthetic hosts from 20:46 to 20:54 UTC, and a notification check with two stock OMP hosts
  from 21:43 to 21:57 UTC. The latency percentiles may include this contention.

| Measure | Result |
|---|---|
| Correctness | Passed (failure code 0) after 28,800 s. All 50 hosts were listed in every one of 1,921 samples. 47,950 metadata changes and 239 host churns reached all 4 subscribers: 191,800 deliveries, 0 pending. The daemon stopped and its private root was removed. |
| View launch | 7,196 launches, 0 failures: p50 1 ms, p95 2 ms, p99 2 ms, max 32 ms |
| Metadata change → SSE receipt, including the discovery wait | p50 1,668 ms, p95 2,885 ms, p99 9,979 ms, max 10,008 ms with a 10-second discovery interval |
| Snapshot reply → SSE receipt | p50 5 ms, p95 8 ms, p99 10 ms, max 15 ms |
| Daemon CPU | 92.4 s in the window, 0.32% of one core |
| Daemon resident memory | 56,160 KiB idle, before any host registered. Under load it started at 66,224 KiB and ended at 62,272 KiB, with a minimum of 44,832, a maximum of 83,808 and a mean of 69,127. Hourly means fell from 80,443 KiB in the first hour to 59,908 KiB in the last. The trend was −3,113 KiB/h: −4,440 in the first half and −3,454 in the second. |
| Open file descriptors | 11 at the start and at the end (maximum 12), with no trend |

These are external growth measurements. The harness does not count internal listeners, events or
history, so neither run alone establishes bounded growth; [the test plan](TEST_PLAN.md#6-performance-targets)
compares them with the targets.

## Mainline v0.6.3 — published stable

**Updated:** 2026-09-27. [v0.6.3](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.3)
was published at **06:29:51 UTC** and is GitHub Latest, with six assets. Signed release workflow
[36300215606](https://github.com/alphastorm/omp-session-gateway/actions/runs/36300215606) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `5e3de461e26cc6f3a149e94088cb42c431bbe002`.<br>
**Stable archive SHA-256:** `45a3e4848aab1e590fbc639ded2118fb74843ea77efe49fe7e9c5c903e4b83e8`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.6.3-prealpha.2](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.3-prealpha.2).<br>
**Source:** `9deb122584a92c3e0519f9884ae56a2c33f6a4c2`.<br>
**Archive SHA-256:** `5a1ba40e79a0c3ca911d8efed0697c41a8732173573c9b2bb814961c892d6c51`.<br>
**Predecessor:** published `v0.6.2`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v063-predecessor-compatibility).

On Windows the candidate installs and runs from a standard (non-elevated) account. v0.6.2 failed
there twice (#293, #294; PR #295): re-securing a private folder whose DACL was already protected
demanded `SeSecurityPrivilege`, and the scheduled task's logon trigger named no user, which only an
administrator may register. Hosted CI (`windows-service-lifecycle`) now installs, reinstalls, starts,
and uninstalls as a standard local user. Before the fixes that step failed with `SeSecurityPrivilege`
([36284537360](https://github.com/alphastorm/omp-session-gateway/actions/runs/36284537360)); with
only #293 fixed, `schtasks` refused the task
([36284539088](https://github.com/alphastorm/omp-session-gateway/actions/runs/36284539088)); with
both it passed
([36284540799](https://github.com/alphastorm/omp-session-gateway/actions/runs/36284540799),
[36285442942](https://github.com/alphastorm/omp-session-gateway/actions/runs/36285442942)).

The Windows qualification lane now also installs the candidate fresh as a standard local account
(#297). Its first development run, on `v0.6.3-prealpha.1` (tested evidence only), found a third
defect (PR #298). Over the account's network logon, WMI refused `Get-ScheduledTask`, so `status`
read the installed, ready gateway as `active: false` while the Task Scheduler's COM interface
reported the task running; a standard user's `status` or `doctor` over SSH met the same misreport.
The candidate asks the COM interface instead. That faster query exposed a latent race. On a hosted
runner, one millisecond after `schtasks /End` the task read Ready with no instances, while its
process and port-4317 listener survived until about 600 ms
([36291384690](https://github.com/alphastorm/omp-session-gateway/actions/runs/36291384690)); a
COM-only change failed a rotation restart
([36291047377](https://github.com/alphastorm/omp-session-gateway/actions/runs/36291047377)).
Stopping now waits for the task's own process. A development run on `v0.6.3-prealpha.2` then passed
the whole lane with no failed phase attempt; see
[Windows qualification](WINDOWS_QUALIFICATION.md#development-evidence--2026-09-27-standard-user-sub-lane).

### Candidate evidence — 2026-09-27

The orchestrator ran from `2a820c01819bcecc68bc05c0fd323805ad1b4118`, 05:28:01Z–06:19:22Z; its
private receipt records `passed`, and every lane passed on its first attempt.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [36291999365](https://github.com/alphastorm/omp-session-gateway/actions/runs/36291999365); predecessor v0.6.2 verified the same way |
| Debian | [36297344192](https://github.com/alphastorm/omp-session-gateway/actions/runs/36297344192) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; stock OMP v18.3.0 built from source; 83/83 migration/recovery invariants |
| Mac | Mac14,3, macOS 26.6.1 arm64; stock OMP v18.3.0 built from source with native addon `ed9ddcee7338`; doctor 18/18, rollback 23/23, rotation and reboot-to-login persistence |
| Windows | Windows Server 2025 build 26100 on a disposable 2-vCPU/4-GiB VM. As Administrator, the candidate installed over published v0.6.2 with stock OMP v18.3.0. It survived a real reboot (three pre-login samples over 66.1 s) and started automatically 99.2 s after interactive logon. Doctor passed 15/18, with only the tagged node's `identityAllowed`, `pwa`, and `sessionHealth` false. The named pipe published at generation 1, View and Control returned `200`, stale generations `409`, all `no-store`. The Pixel accepted the user identity, with View read-only, Control writable, and the prompt accepted. Revocation, readiness rotation, history-selected rollback, restoration, and uninstall preserved configuration and the readiness credential. Then, on the same VM, a standard local account's token held neither Administrators nor `SeSecurityPrivilege`. After the Administrator signed out of Tailscale and the account joined as a new tagged node, the account's fresh install became ready. Three pre-login samples over 52.1 s held its task present but not running, with no process or listener. The gateway started 46.0 s after the account's logon. Its doctor passed 15/18 with the same false set. Rotation changed readiness and kept the configuration, and uninstall kept both. Both accounts' tasks named their own account in the logon trigger |
| OMP publication | stock v18.3.0 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP3A.260905.009, Chrome 153.0.8010.53; View read-only, Control writable, prompt accepted, return to directory; at a 250 ms probe cadence, same-page unlock 7,520 ms (including device wake), Airplane 5,671 ms, Doze 383 ms |
| Background Push | the installed app closed: Private, Session, and Preview delivery on the lock screen in 3.1–4.2 s, each a single notification with matching detail; tap to current Control, stop tap to View only, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery; force-stop `delivered_while_force_stopped` and Doze `undelivered_after_doze_exit` as observed variants; ten forbidden sinks detectable and clean; device, browser, and fixture restored |
| Device cloud | TestingBot real devices ran through the pinned tunnel 4.9. Its proxy refused every destination but the candidate origin and its `connect-src` sources (21, 39, and 52 refusals). On the iPhone 17 Pro Max (iOS 26.6, Safari 26.6), View was read-only, Control writable, the prompt accepted, and the return to directory worked on the candidate's app bundle. Its Home Screen app enabled alerts with a real tap, and the subscription omitted `expirationTime` on `web.push.apple.com`. An attention alert arrived in 10,266 ms with the app in the background, its tap opened current Control with a scrubbed address, and alerts were then turned off. The iPad (9th generation, iPadOS 26.6, Safari 26.6) and the Galaxy S26 (`SM-S942B`, Android 16.0.0, Chrome 145.0.7632.159) passed the same journey. Each device's seven sinks were detectable and clean, and TestingBot's three test records held no live link, video, or screenshot |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-09-27T05:43:28.698Z–06:13:28.705Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Mac's OMP binary and source removed; the Windows VM, its firewall, and its tailnet node destroyed, and its access vault removed |

**Attempts:** this is the candidate's first campaign. `v0.6.3-prealpha.1` was never campaigned: its
development run found #298's defect first.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files** by path, mode, and bytes (`bun run release:compare`), after
re-verifying the candidate digest. Only the existing workflow exclusions apply: release-info.json,
SBOM.spdx.json, STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion
tree was identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the campaign ran a fresh 1,800-second relay check in place of the eight-hour
gate, as every mainline release has. Eight-hour endurance and bounded memory growth are not
claimed. Windows is qualified only as Windows Server 2025 x86-64 started at interactive logon, from
the Administrator and from a fresh standard-account install. The standard account's upgrade,
rollback, OMP, and Pixel journeys are not qualified, because v0.6.2 cannot install without
elevation. Background Web Push is qualified in full only on the Pixel, with force-stop and Doze
outcomes as observed variants. The cloud devices are qualified in the browser at the exact models
and versions above. The tunnel ran on the workstation, so Serve saw the workstation's allowlisted
login, not a phone's. The iPhone's alert was proven with the device unlocked and the app in the
background, not on the lock screen; lock, Airplane, Doze, force-stop, and cellular behavior stay
Pixel-only. Desktop Safari, specialized attention/branch-resume, and broader host/browser
combinations remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
passed in about four minutes (06:32–06:36 UTC). It verified the published provenance and upgraded
the installed gateway from `0.6.2-04bbe8b69b63` to `0.6.3-2e592dd1224d` with the configuration and
readiness token preserved; Tailscale Serve was unchanged and unrelated mappings were preserved.
`doctor` passed 18/18. The `omp` on the default PATH is not stock OMP, so the smoke selected Bun's
global stock OMP 18.1.20, the minimum supported version, and did not reinstall it. The candidate
campaign above, not this smoke, covers the exact OMP 18.3.0.

The install removed the superseded `0.6.0-21e5182fd807` runtime and kept `0.6.3-2e592dd1224d`,
`0.6.2-04bbe8b69b63` and `0.6.1-df63aff418ad`; no prune marker remained, and activation history
records `0.6.2-04bbe8b69b63` as the predecessor that plain `rollback` selects.

On the Pixel, with asset `app.435206ea59ba.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed. No owned tmux session
remained.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.6.3-2e592dd1224d`, and `doctor` passed 18/18. The smoke does not expand the
exact candidate host/client matrix. It runs on macOS, so it does not exercise the Windows
standard-account path this release fixes; that rests on the campaign's Windows lane and hosted CI.
iPhone, iPad, and Galaxy browsers rest on the campaign's cloud lane, and background Push on its
Pixel lane.

## Mainline v0.6.2 — published stable

**Updated:** 2026-09-26. [v0.6.2](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.2)
was published at **16:00:09 UTC** and is GitHub Latest, with six assets. Signed release workflow
[36253822411](https://github.com/alphastorm/omp-session-gateway/actions/runs/36253822411) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `8175a1afdefaaaac8f618585f00e47f07282fa9e`.<br>
**Stable archive SHA-256:** `192090f429c30ad98c94acc7965d215a2f738dd8eef7127c49385a3ed746e617`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.6.2-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.2-prealpha.1).<br>
**Source:** `865abdac0ee23b2b545534b164171a4a070e7197`.<br>
**Archive SHA-256:** `26bbd74317a3c4530f40d645c0881d9011fa3abbacb3af1fe99d9c19899fd153`.<br>
**Predecessor:** published `v0.6.1`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v062-predecessor-compatibility).

The candidate changes no runtime behavior. Its archive and v0.6.1's hold the same 50 files: 45 are
byte-identical, and the gateway bundle, `package.json`, and `bun.lock` differ only in the version
string, beside the release metadata. It is the first candidate whose campaign includes the
real-device cloud lane (ADR-032, #288), which brings iPhone, iPad, and Galaxy browsers into the
qualified matrix. Before #288 merged, the lane passed against an isolated gateway on the
qualification workstation; that was smoke evidence, not qualification. #288 changes qualification
tooling, tests, and documentation only; none of it is in the candidate archive.

### Candidate evidence — 2026-09-26

The orchestrator ran from the candidate's own source, `865abdac0ee23b2b545534b164171a4a070e7197`,
14:55:11Z–15:40:56Z; its private receipt records `passed`, and every lane passed on its first
attempt.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [36249961515](https://github.com/alphastorm/omp-session-gateway/actions/runs/36249961515); predecessor v0.6.1 verified the same way |
| Debian | [36250215581](https://github.com/alphastorm/omp-session-gateway/actions/runs/36250215581) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; stock OMP v18.3.0 built from source; 83/83 migration/recovery invariants |
| Mac | Mac14,3, macOS 26.6.1 arm64; stock OMP v18.3.0 built from source with native addon `ed9ddcee7338`; doctor 18/18, rollback 23/23, rotation and reboot-to-login persistence |
| Windows | Windows Server 2025 build 26100 on a disposable 2-vCPU/4-GiB VM; the candidate installed over published v0.6.1 with stock OMP v18.3.0, survived a real reboot, and started automatically 108.8 s after interactive logon; doctor 15/18 with only the tagged node's `identityAllowed`, `pwa`, and `sessionHealth` false; named-pipe publication at generation 1, View and Control `200`, stale generations `409`, `no-store`; the Pixel accepted the user identity with View read-only, Control writable, and the prompt accepted; revocation, readiness rotation, history-selected rollback, restoration, and uninstall preserved configuration and the readiness credential |
| OMP publication | stock v18.3.0 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP3A.260905.009, Chrome 153.0.8010.53; View read-only, Control writable, prompt accepted, return to directory; at a 250 ms probe cadence, same-page unlock 6,802 ms (including device wake), Airplane 5,209 ms, Doze 363 ms |
| Background Push | the installed app closed: Private, Session, and Preview delivery on the lock screen in 3.0–5.3 s, each a single notification with matching detail; tap to current Control, stop tap to View only, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery; force-stop `delivered_while_force_stopped` and Doze `delivered_after_doze_exit` as observed variants; ten forbidden sinks detectable and clean; device, browser, and fixture restored |
| Device cloud | TestingBot real devices through the pinned tunnel 4.9, whose proxy refused every destination but the candidate origin and its `connect-src` sources (18, 34, and 57 refusals). iPhone 17 Pro Max, iOS 26.6, Safari 26.6: View read-only, Control writable, prompt accepted, and return to directory on the candidate's app bundle; the Home Screen app enabled alerts with a real tap, its subscription omitted `expirationTime` on `web.push.apple.com`, an attention alert arrived in 4,624 ms with the app in the background, its tap opened current Control with a scrubbed address, and alerts were turned off. iPad (9th generation), iPadOS 26.6, Safari 26.6, and Galaxy S26 (`SM-S942B`), Android 16.0.0, Chrome 145.0.7632.159: the same journey. Each device's seven sinks were detectable and clean; TestingBot's three test records held no live link and no video or screenshots; the sessions, tunnel, and fixture were released |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-09-26T15:10:14.697Z–15:40:14.703Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Mac's OMP binary and source removed; the Windows VM, its firewall, and its tailnet node destroyed, and its access vault removed |

**Attempts:** this candidate's campaign above is its first. An earlier campaign ran the new lane on
v0.6.1's candidate and stopped in its artifacts lane before any other lane ran: the orchestrator
qualifies only a candidate whose predecessor is still GitHub Latest, and v0.6.1's publication had
already replaced v0.6.0. That receipt is archived unchanged. Published releases are immutable, so
the cloud evidence needed a new candidate rather than a note on v0.6.1.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files** by path, mode, and bytes (`bun run release:compare`), after
re-verifying the candidate digest. Only the existing workflow exclusions apply: release-info.json,
SBOM.spdx.json, STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion
tree was identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the campaign ran a fresh 1,800-second relay check in place of the eight-hour
gate, as every mainline release has. Eight-hour endurance and bounded memory growth are not
claimed. Windows is qualified only as Windows Server 2025 x86-64 started at interactive logon, and
background Web Push in full only on the Pixel, with force-stop and Doze outcomes as observed
variants. The cloud devices are qualified in the browser at the exact models and versions above:
the tunnel ran on the workstation, so Serve saw the workstation's allowlisted login, not a
phone's; the iPhone's alert was proven with the device unlocked and the app in the background, not
on the lock screen; lock, Airplane, Doze, force-stop, and cellular behavior stay Pixel-only.
Desktop Safari, specialized attention/branch-resume, and broader host/browser combinations remain
unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
passed in 3 minutes 57 seconds (16:01:50–16:05:47 UTC). It verified the published provenance and
upgraded the installed gateway from `0.6.1-df63aff418ad` to `0.6.2-04bbe8b69b63` with the
configuration and readiness token preserved; Tailscale Serve was unchanged and unrelated mappings
were preserved. `doctor` passed 18/18. The `omp` on the default PATH is not stock OMP, so the smoke
selected Bun's global stock OMP 18.1.20, the minimum supported version, and did not reinstall it.
The candidate campaign above, not this smoke, covers the exact OMP 18.3.0.

The install removed the superseded `0.5.3-04e2f32fff8e` runtime and kept `0.6.2-04bbe8b69b63`,
`0.6.1-df63aff418ad` and `0.6.0-21e5182fd807`; no prune marker remained, and activation history
records `0.6.1-df63aff418ad` as the predecessor that plain `rollback` selects.

On the Pixel, with asset `app.435206ea59ba.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed. No owned tmux session
remained.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.6.2-04bbe8b69b63`, and `doctor` passed 18/18. The smoke does not expand the
exact candidate host/client matrix. It does not exercise iPhone, iPad, or Galaxy browsers, which
rest on the campaign's cloud lane; Windows and background Push rest on the campaign lanes above.

## Mainline v0.6.1 — published stable

**Updated:** 2026-09-26. [v0.6.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.1)
was published at **03:03:06 UTC** and is GitHub Latest, with six assets. Signed release workflow
[36213509890](https://github.com/alphastorm/omp-session-gateway/actions/runs/36213509890) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `0d0d804eba20bbc375185e725f5151ddcdd76602`.<br>
**Stable archive SHA-256:** `339da3a0cb67c3cc895d8d20705069c4614be07d5e1e3b6289538148bec291c5`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.6.1-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.1-prealpha.1).<br>
**Source:** `ad8b283b3ac3ccab2a365aebae2428c1771a73c0`.<br>
**Archive SHA-256:** `ce18ba982cd749d8d96144544fbd79d76fd7adfe6b5726089a21de8df3947e74`.<br>
**Predecessor:** published `v0.6.0`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v061-predecessor-compatibility).

The candidate changes one runtime behavior. The shared push-subscription validator treats a missing
`expirationTime` as null, so iPhone and iPad can enable background alerts: WebKit leaves a null
expiration time out of `PushSubscription.toJSON()`, and v0.6.0 rejected that shape in both the PWA
and the gateway (#279, #274). Repository tests cover the WebKit shape; no physical iPhone was
tested, and iPhone and iPad remain outside the qualified matrix. #276–#278, #281, and #283 change
documentation, tests, release tooling, and qualification tooling only; they are not in the
candidate archive.

### Candidate evidence — 2026-09-26

The orchestrator ran from `495aad66f540a6c3514e791fe63447756bba9740`, 02:06:15Z–02:52:50Z; its
private receipt records `passed`, and every lane passed on its first attempt.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [36206305403](https://github.com/alphastorm/omp-session-gateway/actions/runs/36206305403) |
| Debian | [36210688812](https://github.com/alphastorm/omp-session-gateway/actions/runs/36210688812) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; stock OMP v18.3.0 built from source; 83/83 migration/recovery invariants |
| Mac | Mac14,3, macOS 26.6.1 arm64; stock OMP v18.3.0 built from source with native addon `ed9ddcee7338`; doctor 18/18, rollback 23/23, rotation and reboot-to-login persistence |
| Windows | Windows Server 2025 build 26100 on a disposable 2-vCPU/4-GiB VM; the candidate installed over published v0.6.0 with stock OMP v18.3.0, survived a real reboot, and started automatically 121.4 s after interactive logon; doctor 15/18 with only the tagged node's `identityAllowed`, `pwa`, and `sessionHealth` false; named-pipe publication at generation 1, View and Control `200`, stale generations `409`, `no-store`; the Pixel accepted the user identity with View read-only, Control writable, and the prompt accepted; revocation, readiness rotation, history-selected rollback, restoration, and uninstall preserved configuration and the readiness credential |
| OMP publication | stock v18.3.0 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP3A.260905.009, Chrome 153.0.8010.53; View read-only, Control writable, prompt accepted, return to directory; at a 250 ms probe cadence, same-page unlock 6,397 ms (including device wake), Airplane 4,618 ms, Doze 292 ms |
| Background Push | the installed app closed: Private, Session, and Preview delivery on the lock screen in 2.7–4.3 s, each a single notification with matching detail; tap to current Control, stop tap to View only, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery; force-stop `delivered_while_force_stopped` and Doze `delivered_after_doze_exit` as observed variants; ten forbidden sinks detectable and clean; device, browser, and fixture restored |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-09-26T02:22:09.219Z–02:52:09.229Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Mac's OMP binary and source removed; the Windows VM, its firewall, and its tailnet node destroyed, and its access vault removed |

**Attempts:** the first campaign on this candidate (orchestrator `ad8b283`, 00:59:56Z–01:46:15Z)
passed every lane except background Push, which failed at `network_verified`. The clear sent right
after the Airplane recovery arrived 61 s after the answer, 0.4 s after Play Services' push socket
reconnected, while the lane allowed the steady-state 60 s. The gateway sent the clear once and the
phone applied it on arrival; #283 gives every push wait after a radio change the 160-second
recovery window. That receipt is archived unchanged, and the corrected campaign above ran on the
same candidate.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files** by path, mode, and bytes (`bun run release:compare`), after
re-verifying the candidate digest. Only the existing workflow exclusions apply: release-info.json,
SBOM.spdx.json, STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion
tree was identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the campaign ran a fresh 1,800-second relay check in place of the eight-hour
gate, as every mainline release has. Eight-hour endurance and bounded memory growth are not
claimed. Windows is qualified only as Windows Server 2025 x86-64 started at interactive logon, and
background Web Push only on the Pixel, with force-stop and Doze outcomes as observed variants.
iOS/Safari/WebKit, specialized attention/branch-resume and broader host/browser combinations
remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
passed in 4 minutes 1 second (05:40:55–05:44:56 UTC). It verified the published provenance and
upgraded the installed gateway from `0.6.0-21e5182fd807` to `0.6.1-df63aff418ad` with the
configuration and readiness token preserved; Tailscale Serve was unchanged and unrelated mappings
were preserved. `doctor` passed 18/18. The `omp` on the default PATH is the Code Mode launcher, not
stock OMP, so the smoke selected Bun's global stock OMP 18.1.20, the minimum supported version, and
did not reinstall it. The candidate campaign above, not this smoke, covers the exact OMP 18.3.0.

The install removed the superseded `0.5.2-005df2868300` runtime and kept `0.6.1-df63aff418ad`,
`0.6.0-21e5182fd807` and `0.5.3-04e2f32fff8e`; no prune marker remained, and activation history
records `0.6.0-21e5182fd807` as the predecessor that plain `rollback` selects.

On the Pixel, with asset `app.435206ea59ba.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed. The owned disposable
fixture was removed; no owned tmux session or staging directory remained.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.6.1-df63aff418ad`, and `doctor` passed 18/18. The smoke did not modify the Code
Mode launcher or the Bun-global OMP. It does not expand the exact candidate host/client matrix and
does not exercise iPhone or iPad, the platforms this release fixes; Windows and background Push rest
on the campaign lanes above.

## Mainline v0.6.0 — published stable

**Updated:** 2026-09-25. [v0.6.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.0)
was published at **21:23:44 UTC** and is GitHub Latest, with six assets. Signed release workflow
[36191208978](https://github.com/alphastorm/omp-session-gateway/actions/runs/36191208978) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `b39ba822195eb61b27667c3211e816f6e10836fe`.<br>
**Stable archive SHA-256:** `b0394116439bc567b00b04566db05de2cea75d845902d95e6410c3415075f395`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.6.0-prealpha.4](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.6.0-prealpha.4).<br>
**Source:** `25032f076b2df3acdb570612e0083b013f361110`.<br>
**Archive SHA-256:** `56e0445935d37540a7deb97a4ab62145c850e91461b83cdff9ee6608f7a5ff92`.<br>
**Predecessor:** published `v0.5.3`. Rollback does not change OMP; see
[upgrade and rollback](UPGRADE_ROLLBACK.md#v060-predecessor-compatibility).

The candidate is the first whose campaign includes the Windows host lane and the Pixel
background-Push lane (ADR-031, #253, #257). Its shipped bytes change in four places:

- pushes carry no Web Push `Topic`, which FCM throttled after 20 messages per device (#255,
  amending ADR-017);
- the service worker closes a notification no sooner than two seconds after displaying it and
  skips unchanged re-shows (#256);
- the PWA's outage and troubleshooting text speaks of "this device" across Android, iPhone and
  iPad, and computers (#251);
- on Windows, a slow first logon no longer stops the gateway before it listens: it stays alive
  while a failed private-ACL helper is cleared (#263), and a fresh helper's first reply may take
  45 s to cover PowerShell's cold start after install (#265).

#248–#250, #252, #253, #257, #259–#262, #264, and #266–#273 change CI, documentation, tests, and
qualification tooling only; they are not in the candidate archive.

### Candidate evidence — 2026-09-25

The orchestrator ran from `7fbf432df3b89331e658c410369baf9ca7524768`, 20:26:06Z–21:13:21Z; its
private receipt records `passed`, and every lane passed on its first attempt.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [36183296837](https://github.com/alphastorm/omp-session-gateway/actions/runs/36183296837) |
| Debian | [36185868729](https://github.com/alphastorm/omp-session-gateway/actions/runs/36185868729) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; stock OMP v18.3.0 built from source; 83/83 migration/recovery invariants |
| Mac | Mac14,3, macOS 26.6.1 arm64; stock OMP v18.3.0 built from source with native addon `ed9ddcee7338`; doctor 18/18, rollback 23/23, rotation and reboot-to-login persistence |
| Windows | Windows Server 2025 build 26100 on a disposable 2-vCPU/4-GiB VM; the candidate installed over published v0.5.3 with stock OMP v18.3.0, survived a real reboot, and started automatically 103.5 s after interactive logon; doctor 15/18 with only the tagged node's `identityAllowed`, `pwa`, and `sessionHealth` false; named-pipe publication at generation 1, View and Control `200`, stale generations `409`, `no-store`; the Pixel accepted the user identity with View read-only, Control writable, and the prompt accepted; revocation, readiness rotation, history-selected rollback, restoration, and uninstall preserved configuration and the readiness credential |
| OMP publication | stock v18.3.0 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP3A.260905.009, Chrome 153.0.8010.53; View read-only, Control writable, prompt accepted, return to directory; at a 250 ms probe cadence, same-page unlock 6,836 ms (including device wake), Airplane 5,196 ms, Doze 286 ms |
| Background Push | the installed app closed: Private, Session, and Preview delivery on the lock screen in 3.6–4.3 s, each a single notification with matching detail; tap to current Control, stop tap to View only, stale-generation scrub without a launch, authoritative clear with a fresh request retained, permission revocation, lock/resume, Wi-Fi and cellular delivery, Airplane suppression and recovery; force-stop `delivered_while_force_stopped` and Doze `delivered_after_doze_exit` as observed variants; ten forbidden sinks detectable and clean; device, browser, and fixture restored |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-09-25T20:42:40.785Z–21:12:40.785Z; four transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Mac's OMP binary and source removed; the Windows VM, its firewall, and its tailnet node destroyed, and its access vault removed |

**Attempts:** every lane passed on its first attempt. Earlier v0.6.0 candidates did not qualify,
and their receipts are archived unchanged:

- v0.6.0-prealpha.1: two campaigns failed on qualification-tooling defects (#259, #260, #262) and
  on the Windows first-logon exit that #263 and #265 fix in the runtime.
- v0.6.0-prealpha.2 carries #263 but not #265; it failed the same logon step in a development run.
- v0.6.0-prealpha.3 has this candidate's runtime bytes. Its two campaigns passed every lane except
  background Push, including Windows on fresh VMs. Push failed after forced Doze: first
  `doze_verified` enforced a delivery that ADR-031 records only as an observed variant (#271), then
  `network_verified` inherited Chrome's post-Doze push deferral (#272). Those campaigns used all
  four Windows VM creations the campaign allows per candidate, so v0.6.0-prealpha.4 was tagged on
  #272's merge. Its archive matches v0.6.0-prealpha.3's 50 members except `release-info.json` and
  `SBOM.spdx.json`.

Before this campaign, the Windows lane passed development runs against v0.6.0-prealpha.3 on two
fresh VMs (automatic start 82.0 s and 98.6 s after the first logon), and the fixed Push lane passed
one development run on the retained Mac. Both are tested evidence.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files**, paths and modes, after re-verifying the candidate digest.
Only the existing workflow exclusions apply: release-info.json, SBOM.spdx.json,
STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion tree was
identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the campaign ran a fresh 1,800-second relay check in place of the eight-hour
gate, as every mainline release has. Eight-hour endurance and bounded memory growth are not
claimed. Windows is qualified only as Windows Server 2025 x86-64 started at interactive logon, and
background Web Push only on the Pixel, with force-stop and Doze outcomes as observed variants.
iOS/Safari/WebKit, specialized attention/branch-resume and broader host/browser combinations
remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
passed in 3 minutes 58 seconds (21:25:12–21:29:10 UTC). It verified the published provenance and
upgraded the installed gateway from `0.5.3-04e2f32fff8e` to `0.6.0-21e5182fd807` with the
configuration and readiness token preserved; Tailscale Serve was unchanged and unrelated mappings
were preserved. `doctor` passed 18/18. The `omp` on the default PATH is the Code Mode launcher, not
stock OMP, so the smoke selected Bun's global stock OMP 18.1.20, the minimum supported version, and
did not reinstall it. The candidate campaign above, not this smoke, covers the exact OMP 18.3.0.

The install removed the superseded `0.5.1-8f5031174380` runtime and kept `0.6.0-21e5182fd807`,
`0.5.3-04e2f32fff8e` and `0.5.2-005df2868300`; no prune marker remained, and the plain `rollback`
target resolves to the recorded predecessor `0.5.3-04e2f32fff8e`.

On the Pixel, with asset `app.fb82a6fd113f.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed. The owned disposable
fixture was removed; no owned tmux session or staging directory remained.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.6.0-21e5182fd807`, and `doctor` passed 18/18. The smoke did not modify the Code
Mode launcher or the Bun-global OMP. It does not expand the exact candidate host/client matrix;
Windows and background Push rest on the campaign lanes above.

## Mainline v0.5.3 — published stable

**Updated:** 2026-09-24. [v0.5.3](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.3)
was published at **12:19:55 UTC** and is GitHub Latest, with six assets. Signed release workflow
[35998260472](https://github.com/alphastorm/omp-session-gateway/actions/runs/35998260472) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `54356c80b21e101c25eca9be8119d4ffe62d50c9`.<br>
**Stable archive SHA-256:** `42882e10937ded6064bb0aa5de89e76df76b7d02a92797906889238bb5bc227b`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.5.3-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.3-prealpha.1).<br>
**Source:** `e0718628074527746096d74398f112900aea5ee5`.<br>
**Archive SHA-256:** `95377102279da3867295cf6ec991992a1f3c9c0cab5d62cee4b5f5fbf5ffadab`.<br>
**Predecessor:** published `v0.5.2`. Rollback does not change OMP; v0.5.2 renders OMP 18.3.0's
`wait` tool calls as generic tool cards.

The candidate moves the OMP engineering and qualified baseline to stock v18.3.0 and refreshes the
embedded collaboration client to its `collab-web` (#242). The client renders OMP 18.3.0's `wait`
tool, keeps the hub-family tool cards older supported hosts still emit, and memoizes the
transcript's active-tool scan. #240, #241, #243, and #244 change qualification fixtures and smoke
tooling, documentation, the daily upstream canary, and workflow linting only; they are not in the
candidate archive. The minimum OMP contract remains 18.1.20.

### Candidate evidence — 2026-09-24

The orchestrator ran from the candidate source `e0718628074527746096d74398f112900aea5ee5`; its
private receipt records `passed`.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [35991612617](https://github.com/alphastorm/omp-session-gateway/actions/runs/35991612617) |
| Debian | [35992100974](https://github.com/alphastorm/omp-session-gateway/actions/runs/35992100974) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; stock OMP v18.3.0 built from source (`omp/18.3.0`); 83/83 migration/recovery invariants; predecessor v0.5.2; droplet, tailnet node and ephemeral SSH key removed |
| Mac | Mac14,3, macOS 26.6.1 arm64; stock OMP v18.3.0 built from source at `62bc57be1b03` / tree `b36226cce6a2` with native addon `ed9ddcee7338`; doctor 18/18, token rotation `d83119faafb7` → `4467e3e14d5a`, reboot-to-login persistence with unchanged token digest, rollback invariants 23/23; archive digest matched |
| OMP publication | stock v18.3.0 host, generation 1; View and Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP2A.260805.005, Chrome 153.0.8010.52, asset `app.179f57dc0fd6.js`; View read-only, Control writable, prompt accepted, return to directory; at a 250 ms probe cadence, same-page unlock 5,866 ms (including device wake), Airplane 7,006 ms, Doze 286 ms |
| Secret sinks | all seven sinks detectable and clean |
| Relay | 1,800 seconds, 2026-09-24T11:31:08.494Z–12:01:08.504Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; the Mac's OMP binary and source removed |

**Attempts:** no lane failed. The artifacts lane records two attempts because the first
orchestrator launch was stopped during that read-only lane and relaunched in its own session, so
that a tool deadline could not interrupt a live lane; every other lane passed on its first
attempt.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files**, paths and modes, after re-verifying the candidate digest.
Only the existing workflow exclusions apply: release-info.json, SBOM.spdx.json,
STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion tree was
identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the founder renewed a fresh 1,800-second relay check for this candidate.
Eight-hour endurance and bounded memory growth are not claimed. Windows OMP, background Push,
iOS/Safari/WebKit, specialized attention/branch-resume and broader host/browser combinations
remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
passed in 3 minutes 54 seconds (12:22:26–12:26:20 UTC). It verified the published provenance and
upgraded the installed gateway from `0.5.2-005df2868300` to `0.5.3-04e2f32fff8e` with the
configuration and readiness token preserved; Tailscale Serve was unchanged and unrelated mappings
were preserved. `doctor` passed 18/18. The smoke selected an isolated stock OMP 18.3.0 install
placed after the pinned Bun on `PATH` and did not reinstall OMP; the Bun-global stock OMP 18.1.20
was not changed.

The install removed the superseded `0.5.0-a88b8ba9ed61` runtime and kept `0.5.3-04e2f32fff8e`,
`0.5.2-005df2868300` and `0.5.1-8f5031174380`; no prune marker remained, and the plain `rollback`
target resolves to the recorded predecessor `0.5.2-005df2868300`.

On the Pixel, with asset `app.179f57dc0fd6.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed. The owned disposable
fixture was removed; no owned tmux session or staging directory remained.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.5.3-04e2f32fff8e`, and `doctor` passed 18/18. The smoke did not modify the Code
Mode launcher on the default PATH. The smoke does not expand the exact candidate host/client matrix
or qualify background Push.

## Mainline v0.5.2 — published stable

**Updated:** 2026-09-24. [v0.5.2](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.2)
was published at **09:16:17 UTC** and is GitHub Latest, with six assets. Signed release workflow
[35980094058](https://github.com/alphastorm/omp-session-gateway/actions/runs/35980094058) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `ed63a934f6b85513d6d9242dd43566e9b39466c3`.<br>
**Stable archive SHA-256:** `898a334ecc8d41551dd0dcfba57104d1ed1006a57c7fbbfca922c9a94669ffb9`.

The published-byte workstation/Pixel smoke passed on its **second attempt**; see below.

**Candidate:** [v0.5.2-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.2-prealpha.1).<br>
**Source:** `86cb8584bd13bd66b37587e45a6bd917b5f30556`.<br>
**Archive SHA-256:** `a380baaa33e8d41bb733a5c7581beba4ba0577a455bd3bbc662537828c48bdee`.<br>
**Predecessor:** published `v0.5.1`. Rollback does not change OMP; v0.5.1 rejects OMP registry
fields it does not know and rereads leftover discovery files every round.

The candidate carries #233 (unknown fields that OMP adds under registry v1 no longer hide sessions;
leftover discovery files from killed OMP processes no longer keep new sessions out of the scan) and
#235/#231 (a successful ready install prunes superseded staged runtimes while keeping the active
runtime, two distinct predecessors, and any divergent service runtime). #234 and #237 change
qualification tooling only and are not in the candidate archive: the capacity workflow config is
repaired, Android recovery is probed at a 250 ms cadence, and release-asset downloads retry
transient GitHub HTTP 5xx. The minimum OMP contract remains 18.1.20.

### Candidate evidence — 2026-09-24

The passing orchestrator ran from `50eeb9569239cd5b1ad9159c0ea4fe520805b8cd` (candidate source
plus #237); its private receipt records `passed`.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [35966146523](https://github.com/alphastorm/omp-session-gateway/actions/runs/35966146523) |
| Debian | [35967074443](https://github.com/alphastorm/omp-session-gateway/actions/runs/35967074443) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; 83/83 migration/recovery invariants; predecessor v0.5.1; droplet, tailnet node and ephemeral SSH key removed |
| Mac | Mac14,3, macOS 26.6.1 arm64; doctor 18/18, token rotation, reboot-to-login persistence with unchanged token digest, rollback invariants 23/23; archive digest matched |
| OMP publication | exact stock 18.1.20 (`1bd60c6f`); generation-1 View/Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP2A.260805.005, Chrome 153.0.8010.52, asset `app.39cccc9c245b.js`; View read-only, Control writable, prompt accepted, return to directory; at a 250 ms probe cadence, same-page unlock 5,949 ms (including device wake), Airplane 5,236 ms, Doze 323 ms |
| Secret sinks | all seven sinks detectable and clean; no capability in resource timings or DOM |
| Relay | 1,800 seconds, 2026-09-24T08:22:42.272Z–08:52:42.274Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts |

Recovery milliseconds are no longer comparable with earlier ledger rows: those recorded the first
probe after a fixed 8-second (3-second for unlock) wait, not the recovery itself.

**Earlier attempts:** the first orchestrator run, from `86cb858`, stopped in the artifacts lane
when GitHub answered HTTP 500 to the candidate asset download, before any other lane started. Its
private receipt is archived unchanged as failed, and #237 added the bounded download retry. The
passing receipt's first run passed artifacts, Debian, and Mac, then three lanes failed against the
retained Mac. After Doze the Pixel's page reported the gateway unavailable, then the desktop and
then the tailnet unreachable, and did not recover within the 48-second window, although 75 of 76
pings from the device shell to the Mac succeeded. The relay lane ran from 07:09:17Z to 08:06:50Z
and ended with a command timeout (`bun timed out`). Cleanup SSH to the Mac failed. The first OMP
publication attempt was left incomplete (`running`), not failed. The Mac's gateway process ran
throughout without restarting, and the Mac did not sleep. A bounded Android-only run of the same
lane against the retained fixture then passed (Doze 363 ms). The resume re-verified the artifacts
and passed OMP publication, Android, relay, and cleanup on their second attempts. The cause of the
failures is not established.

**Runtime equivalence:** a clean `OMP_RELEASE_CHANNEL=stable` build of the promotion tree matched
all **46 non-metadata candidate files**, paths and modes, after re-verifying the candidate digest.
Only the existing workflow exclusions apply: release-info.json, SBOM.spdx.json,
STABLE_RELEASE.lock.json, and schemas/stable-release.schema.json. The merged promotion tree was
identical, and the published stable archive also matched all 46 candidate files.

**Assurance scope:** the founder renewed a fresh 1,800-second relay check for this candidate.
Eight-hour endurance and bounded memory growth are not claimed. Windows OMP, background Push,
iOS/Safari/WebKit, specialized attention/branch-resume and broader host/browser combinations
remain unqualified. Every other release gate stays required. The first capacity run on the
discovery-polling design, [35963993897](https://github.com/alphastorm/omp-session-gateway/actions/runs/35963993897)
on `922bf47`, held 50 hosts for 600 seconds at 0.365% of one core and 63,236 KiB peak RSS; it
promotes no ledger row.

### Published-byte workstation/Pixel verification

The first `smoke:release` invocation, bound to the stable tag, source and archive digest above,
verified the published provenance, upgraded the installed gateway from `0.5.1-8f5031174380` to
`0.5.2-005df2868300`, and passed the Serve and `doctor` steps. It then stopped at its OMP identity
check: the `omp` on the default `PATH` resolves to the Code Mode launcher, which the smoke refuses
as a different product, so no fixture or Pixel step ran. The install removed 33 of the 35 earlier
staged runtimes and kept `0.5.2-005df2868300`, `0.5.1-8f5031174380` and `0.5.0-a88b8ba9ed61`; no
prune marker remained, and the plain `rollback` target is `0.5.1-8f5031174380`.

The second invocation placed the existing stock OMP 18.1.20 Bun global bin after the pinned Bun on
`PATH` and passed in 3 minutes 49 seconds. It verified the installed gateway with the configuration
and readiness token preserved; Tailscale Serve was unchanged and unrelated mappings were preserved.
`doctor` passed 18/18. It reused stock OMP 18.1.20 without reinstalling it.

On the Pixel, with asset `app.39cccc9c245b.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed. The owned disposable
fixture was removed; the smoke fails if its tmux session survives cleanup.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.5.2-005df2868300`, and `doctor` passed 18/18. The Code Mode launcher on the
default PATH was unchanged. The smoke does not expand the exact candidate host/client matrix or
qualify background Push.

## Mainline v0.5.1 — published stable

**Updated:** 2026-09-23. [v0.5.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.1)
was published at **12:00:29 UTC** and is GitHub Latest, with six assets. Signed release workflow
[35857735009](https://github.com/alphastorm/omp-session-gateway/actions/runs/35857735009) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `678e32a0a087b57cf33ec846bc772dea87d6831b`.<br>
**Stable archive SHA-256:** `66a3d63cd8f75ab01631cb1d371dcdc199c1bc769ec1f9243f17f4db7e2c75d3`.

The published-byte workstation/Pixel smoke passed on its **first attempt**; see below.

**Candidate:** [v0.5.1-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.1-prealpha.1).<br>
**Source:** `ba64d4ad8fe7f30f16db40d57475af06e93fda6b`.<br>
**Archive SHA-256:** `ac7abda743cb75ea7224cc4eba1a506360a52c55dc4ab67ebe933339be9acfcf`.<br>
**Predecessor:** published `v0.5.0`. Rollback does not change OMP; it restores v0.5.0's update
activation, which can navigate an open page back to the directory (#226).

This release carries #226: shell-update activation no longer navigates clients, the page's
bounded reload waits for pending launches, routed notifications, and mounted collaboration, and the
post-release smoke settles the installed shell and reports closed-vocabulary lane stages. #228
changes qualification tooling only; it is not in the candidate archive. The minimum OMP contract
remains 18.1.20.

### Candidate evidence — 2026-09-23

The passing orchestrator ran from `42a5642691256b5de5b0dd509347f84233bcd918` (candidate source
plus #228); its private receipt records `passed` with exactly one attempt per lane.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [35849414930](https://github.com/alphastorm/omp-session-gateway/actions/runs/35849414930) |
| Debian | [35851744582](https://github.com/alphastorm/omp-session-gateway/actions/runs/35851744582) succeeded against the candidate archive; Debian 13 (trixie), Linux 6.12.94+deb13-amd64; 83/83 migration/recovery invariants; predecessor v0.5.0; droplet, tailnet node and ephemeral SSH key removed |
| Mac | Mac14,3, macOS 26.6.1 arm64; doctor 18/18, token rotation, reboot-to-login persistence with unchanged token digest, rollback invariants 23/23; archive digest matched |
| OMP publication | exact stock 18.1.20 (`1bd60c6f`); generation-1 View/Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP2A.260805.005, Chrome 153.0.8010.52, asset `app.18b30e778c13.js`; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 9,297 ms, Airplane 8,496 ms, Doze 8,375 ms |
| Secret sinks | all seven sinks detectable and clean; no capability in resource timings or DOM |
| Relay | 1,800 seconds, 2026-09-23T11:10:25.233Z–11:40:25.240Z; two transitions, final phase live |
| Cleanup | zero gateway processes, zero listeners, zero live OMP hosts; OMP binary and source absent |

**First attempt:** the same candidate's first orchestrator run, from `ba64d4a`, stopped in Debian
run [35850590104](https://github.com/alphastorm/omp-session-gateway/actions/runs/35850590104)
before any droplet existed. DigitalOcean had not made the freshly registered ephemeral SSH key
readable within the provisioner's five reads, and teardown's name sweep missed the same key; it
was deleted by hand and then read back as 404. No other lane had started. That private receipt
remains **failed** and unchanged beside the passing one. [#228](https://github.com/alphastorm/omp-session-gateway/pull/228)
waits about a minute for the key and deletes the exported key id in teardown.

**Runtime equivalence:** a clean stable-channel build of the promotion tree matched all **46
non-metadata candidate files**, paths and modes, after re-verifying the candidate digest. Only the
existing workflow exclusions apply: release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json,
and schemas/stable-release.schema.json. The merged promotion tree was identical, and the published
stable archive also matched all 46 candidate files.

**Assurance scope:** the founder renewed a fresh 1,800-second relay check for this candidate.
Eight-hour endurance and bounded memory growth are not claimed. Windows OMP, background Push,
iOS/Safari/WebKit, specialized attention/branch-resume and broader host/browser combinations
remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

One `smoke:release` invocation, bound to the stable tag, source and archive digest above, passed
on its first attempt in 4 minutes 15 seconds. It verified the published provenance and upgraded
the installed gateway from `0.5.0-a88b8ba9ed61` to `0.5.1-8f5031174380`, preserving the
configuration and readiness token; Tailscale Serve was unchanged and unrelated mappings were
preserved. `doctor` passed 18/18. It reused stock OMP 18.1.20 without reinstalling it.

On the Pixel, with asset `app.18b30e778c13.js`, View was read-only and Control writable; the
capability-sink, same-page recovery, and installed-WebAPK checks passed. The owned disposable
fixture was removed; the smoke fails if its tmux session survives cleanup.

Afterwards, `status` reported active, ready, tailscale-serve and not diverged, with active and
service versions `0.5.1-8f5031174380`. The Code Mode launcher on the default PATH was unchanged.

The v0.5.0 smoke below failed its first View/Control attempt after the upgrade; this first attempt
passed. That is consistent with #226, but one pass does not prove the race is gone. The smoke does
not expand the exact candidate host/client matrix or qualify background Push.

## Mainline v0.5.0 — published stable

**Updated:** 2026-09-23. [v0.5.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.0)
was published at **07:14:56 UTC** and is GitHub Latest, with six assets. Signed release workflow
[35830629330](https://github.com/alphastorm/omp-session-gateway/actions/runs/35830629330) passed
all gates, including the final runtime comparison and three attestations / three Sigstore bundles.
The published archive matches the complete clean local stable-channel build.

**Stable source:** `1750ab454be1517d615167343562304766abb99c`.<br>
**Stable archive SHA-256:** `f5e80b405cdd9e075fcb068e1ced070242d37423b103e549169da00facb47834`.

Published-byte workstation/Pixel checks are complete through the bounded follow-up paths recorded
below. The first full smoke invocation failed at Android View/Control; that failure remains
recorded, and its diagnosis follows the verification record.

**Candidate:** [v0.5.0-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.5.0-prealpha.1).<br>
**Source:** `3208654b7ec37330d4314c3d69930eb0b3173606`.<br>
**Archive SHA-256:** `6a3b061cb57e38acbf765ca85fc2f98e5bc47577e79ccd3d1c903f7f3083b0f5`.<br>
**Predecessor:** published `v0.4.2`. Rollback does not change OMP; this predecessor rejects
busy-emitting hosts and can restore #219 despite reporting service readiness.

This release includes #220/#219 (additive activity metadata no longer hides live sessions),
#221/#197 (optional activity display and metadata-only stop alerts), and #222 (canonical list/SSE
schemas). Activity alerts require observed working-to-idle transitions, preserve ask precedence,
and do not imply task success. Physical background Push and the broader attention matrix remain
unqualified. The minimum OMP contract remains 18.1.20; later-version parser regressions do not
qualify every later OMP release.

### Candidate evidence — 2026-09-23

The single orchestrator used source `3208654`. Its six non-cleanup lanes passed once; its original
private receipt remains **failed** because cleanup used PID liveness incorrectly. It has not been
rewritten or relabeled. The failed cleanup boundary was reproduced, fixed, and exercised directly
on the retained Mac's actual post-failure state. This approval composes those unchanged candidate
lanes with the corrected cleanup evidence below, not a claim that the original run passed wholesale.

| Lane | Evidence |
|---|---|
| Artifacts | signed tag, checksums, GitHub attestations 3/3, Sigstore bundles 3/3; release run [35823273490](https://github.com/alphastorm/omp-session-gateway/actions/runs/35823273490) |
| Debian | [35824487789](https://github.com/alphastorm/omp-session-gateway/actions/runs/35824487789) succeeded on candidate source; predecessor v0.4.2; droplet, tailnet node and ephemeral SSH key removed |
| Mac | Mac14,3, macOS 26.6.1 arm64; doctor 18/18, rollback invariants 23/23; archive digest matched |
| OMP publication | exact stock 18.1.20; generation-1 View/Control returned 200 with capability present and no-store; host published and revoked |
| Android | Pixel 10 Pro, Android 17 CP2A.260805.005, Chrome 153.0.8010.52; View read-only, Control writable, prompt accepted, return to directory; same-page unlock 9,138 ms, Airplane 8,309 ms, Doze 8,356 ms |
| Secret sinks | all seven sinks detectable and clean; no capability in resource timings or DOM |
| Relay | 1,800 seconds, 2026-09-23T06:08:25.733Z–06:38:25.743Z; two transitions, final phase live |
| Cleanup | original gateway uninstall: zero processes/listeners; corrected OMP helper: exit 0, liveOmpHosts 0, binaryPresent false, sourcePresent false |

**Cleanup correction:** [#223](https://github.com/alphastorm/omp-session-gateway/pull/223), verified
commit `795689bb55699686aa3b72b25f370db7b947b7ff` (merged as `671bb14273a44d78f2847600c666cc3d17d5426c`).
A stale discovery PID belonged to macOS dprivacyd; the published socket returned ECONNREFUSED.
The corrected helper probes the published endpoint, treats only ENOENT/ECONNREFUSED as dead,
and keeps other errors blocking. Direct execution on that same Mac state passed, with the stale
record and unrelated process preserved. Missing/refused-endpoint regressions failed before the
fix; 53 focused tests / 234 assertions passed afterward, including live and indeterminate endpoints.
No gateway runtime or release machinery changed. Re-signing the commit changed no source bytes.

**Runtime equivalence:** a clean build of the corrected source matched all **46 non-metadata
candidate files**, paths and modes, after re-verifying the candidate digest. Only the existing
workflow exclusions apply: release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json, and
schemas/stable-release.schema.json. The final merged promotion tree also passed this comparison; the signed release workflow
rechecked the published candidate against the stable archive.

**Assurance scope:** the founder renewed a fresh 1,800-second relay check for this candidate.
Eight-hour endurance and bounded memory growth are not claimed. Windows OMP, background Push,
iOS/Safari/WebKit, specialized attention/branch-resume and broader host/browser combinations
remain unqualified. Every other release gate stays required.

### Published-byte workstation/Pixel verification

The verified published archive above is installed as `0.5.0-a88b8ba9ed61`. The service is active,
ready, uses tailscale-serve authentication, and its active/service versions agree.

Rechecked on 2026-09-23 at the founder's request: `status` reported active, ready, and not
diverged; `doctor` passed 18/18; GitHub Latest was `v0.5.0` with six assets and the archive digest
above. All 47 runtime files shared with a fresh download of that archive were byte-identical in the
installed version directory. The only differences were an added `installation.json`, the absent
stable lock and its schema, and `cli.js` at mode 0700.

The original `smoke:release` invocation completed downloaded checksum/signature/attestation checks,
exact tag/source verification, gateway installation with configuration and readiness-token
preservation, unrelated Serve-mapping preservation, doctor checks, and reuse of existing stock
OMP 18.1.20. It then **failed at Android View/Control**. The wrapper withheld the child error, so
the failing step of that run is unrecorded. No clean first-attempt upgrade is claimed.

A bounded Android-only probe then exercised the same installed archive and expected
`app.b3055eccd928.js` asset: View read-only, Control writable, prompt accepted, return to the
directory, Chrome 153.0.8010.52. It passed. The remaining existing capability-sink sweep,
same-page lock/Airplane/Doze recovery, and installed-WebAPK checks then passed separately.
Each probe used and removed an owned disposable fixture; fixture revocation, tmux cleanup,
ownership-checked directory removal and private staging cleanup completed. Installation and
30-minute qualification were not repeated. Temporary diagnostic code was not added to the product.

This is composed published-byte verification, **not** a relabeled passing result for the original
failed smoke command. Stock OMP was not reinstalled and the Code Mode launcher was not replaced.
The gateway and PWA remain installed. The workstation smoke does not expand the exact candidate
host/client matrix or qualify background Push.

### Diagnosis of the first View/Control failure — 2026-09-23

The failure matches the PWA update activation. The original child output was withheld, so this
attributes that run by mechanism, not by a recovered error.

- **Worker view of clients.** In desktop Chromium, `Clients.matchAll()` kept reporting `/` for a
  page that had moved to `/client/` through `pushState` or `replaceState`, and
  `client.navigate("/update/")` then navigated it. The v0.5.0 worker navigates every client it sees
  at `/` when it activates over a prior shell cache.
- **Reproduction on v0.5.0 source.** A live View page and a pending launch each returned to the
  directory when an upgraded worker activated, about one second after the controller change. The
  page's own fallback also reloaded while a second launch was still pending, or while a routed
  notification awaited its snapshot.
- **Run shape.** The smoke installed v0.5.0 and then drove View with no settle, on the Pixel's
  first visit after the upgrade. The acceptance and leak-sweep lanes wait 8 and 6 seconds before
  interacting, and qualification runs acceptance first. This is consistent with first-attempt
  qualification passes and the first-attempt View/Control failures after the v0.4.0, v0.4.2, and
  v0.5.0 upgrades. That link is an inference; those earlier outputs were also lost.

**Fix, released in v0.5.1 (#226):** activation retires shells and claims clients without navigating any
of them (ADR-018 amendment). The page's bounded reload waits for every pending launch and routed
notification, and a launch failing after another launch mounted a collaboration no longer rewrites
that page's route, removes its shared stylesheet, or reloads it. An expired routed notification
now applies a deferred update. Five of the six update end-to-end cases fail on the v0.5.0 source;
all six pass after the fix, and the worker unit case fails on the v0.5.0 worker. The
collaboration smoke now waits until the controlling worker's only shell cache holds the page's own
app bundle, which must be the release bundle, then starts from a fresh document. Android lanes
announce closed-vocabulary stages, and the post-release smoke reports the last one instead of
withholding everything; malformed lane stdout no longer reaches a quoted JSON parse error. The
installed v0.5.0 bytes are unchanged; the fix reaches the Pixel only through a release, and no
physical rerun of the original failure is claimed.

**Pixel shell install time.** A read-only DevTools read of the Pixel's shell cache found the v0.5.0
bundle (`app.b3055eccd928.js`, `app.c349fe1b819f.css`) fetched at **07:17:19 UTC**. That is inside
the failed smoke, launched at 07:16:34 with its failure visible by 07:19:00, and before the passing
Android-only probe at about 07:22. The new shell was installed during the failed run, not before
it, and a `skipWaiting` install activates immediately; the passing probe ran against a current
worker. The worker read as active with nothing installing or waiting.

## Mainline v0.4.2 — published stable

**Updated:** 2026-09-22. **Decision: GO for stable v0.4.2** on the exact matrix recorded under the
0.4.1 engineering track below, which this campaign re-exercised unchanged. The seven-lane candidate
campaign passed against `v0.4.2-prealpha.1` with orchestrator `a2c43d6`, starting
**14:23:37.957 UTC** and completing **15:07:10.105 UTC**. Every lane passed on its first attempt.

**Qualified candidate:** [v0.4.2-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.2-prealpha.1).<br>
**Candidate source:** `a2c43d60edbe21ff73a38baab478725798055723`.<br>
**Candidate archive SHA-256:** `4a1c0cddeecb9e6e75811e9890f53a10f9c739c4192a7aaa9d3d94a716385135`.<br>
**Rollback predecessor:** published stable `v0.4.1`, derived from the stable lock rather than a
hand-maintained constant.

**What this release changes for a user:** returning to a backgrounded session lands back in that
session instead of the session directory, so switching apps on a phone no longer looks like the
session dying. A Windows-only ACL helper retry also lands, on a platform that stays unqualified and
unadvertised.

**Limits, unchanged from v0.4.1:** eight-hour endurance is NOT rerun and is NOT CLAIMED; the
1,800-second relay check stands in for it and residual prolonged-operation risk is accepted. There
is no bounded-memory-growth claim. Windows OMP, background Web Push, specialized attention and
branch/resume matrices, iOS, Safari, WebKit, and broader host/browser combinations remain
unqualified. Session resume is proven by the browser lane and the physical Pixel only; it carries no
iOS claim.

### Candidate evidence — seven lanes, 2026-09-22

| Lane | Result |
| --- | --- |
| artifacts | signed tag, checksums passed, GitHub attestations **3/3**, Sigstore bundles **3/3** |
| debian | run [`35740074929`](https://github.com/alphastorm/omp-session-gateway/actions/runs/35740074929) success on head `a2c43d6` |
| macos | retained Mac14,3, macOS 26.6.1 arm64, `doctor` **18/18**, rollback invariants **23/23** |
| ompPublication | instance `5ecf6865…` generation 1; View and Control both `200` with capability present and `no-store`; published then revoked |
| android | physical Pixel 10 Pro (serial recorded in the private receipt, not published), Android 17 `CP2A.260805.005`, Chrome 153.0.8010.52; unlock 9,230 ms, airplane recovery 8,394 ms, doze recovery 8,449 ms |
| relay | **1,800 s** exactly, 2 transitions, final phase `live` |
| cleanup | 0 gateway processes, 0 listeners, 0 live OMP hosts |

**Secret sinks: clean.** The capability was absent from all seven sinks, from resource timings, and
from the DOM; the tailnet address was recorded as a zero-character hash.

**Runtime byte comparison: passed.** A stable-channel build of the promotion tree reproduced the
qualified candidate archive across **49 of 50 files with zero differences**, with file modes
identical across all 50. The single difference is `release-info.json`, and only its `qualification`
string — the channel claim the build derives from `OMP_RELEASE_CHANNEL`. A pre-alpha-channel build
of the same tree reproduced the published candidate archive SHA-256 `4a1c0cdd…85135` exactly. The
comparison requires the pinned Bun on `PATH`, not merely as the invoked binary: `release:build`
spawns the web build through a nested `bun`.

### Publication — verified 2026-09-22

**Published stable:** [v0.4.2](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.2),
immutable GitHub Latest at **15:20:26 UTC**, six assets.<br>
**Stable source:** `fe47366da0abf9b98004ab54641737d2c24cd713`.<br>
**Stable archive SHA-256:** `e64846074292e3863b2897a6e029b8ce051c3b6e160b39c2efbe0f8483d9b297`.<br>
**Release run:** [`35746502353`](https://github.com/alphastorm/omp-session-gateway/actions/runs/35746502353), passed.

Verified after publication against the downloaded assets, not the workflow log: the archive digest
matches its `SHA256SUMS` entry, `gh attestation verify` accepted it, and the GitHub Latest pointer
resolves to `v0.4.2`.

**Runtime equivalence against the qualified candidate: passed.** Unpacking the published stable
archive beside the qualified candidate leaves **exactly three differing files, all of them the
documented metadata exclusions** — `release-info.json`, `SBOM.spdx.json`, and
`STABLE_RELEASE.lock.json`. The remaining **47 files are byte-identical**.

**Published-byte local installation:** the workstation gateway runs published
`0.4.2-9bad54b14928`, reporting installed, active, ready, and not diverged, with `doctor` **18/18**.
Existing configuration and readiness-token bytes were preserved.

### Post-release smoke — passed 2026-09-22

`bun run smoke:release -- --tag v0.4.2 --archive-sha256 e648460… --rebuild-omp` passed against the
published digest on the configured Darwin-arm64 workstation and the physical Pixel:

- exact tag, source commit `fe47366`, archive `e648460…`, and application asset
  `/assets/app.ce7356a7cb95.js` bound to the published release;
- gateway reinstall not required, **configuration and readiness-token bytes preserved**, `doctor`
  **18/18**;
- Tailscale Serve unchanged with unrelated mappings preserved;
- mainline OMP **18.1.20**, binary `b3718d4e…`;
- physical Pixel: View read-only, Control writable, capability sinks clean, same-page recovery, and
  the installed WebAPK launch.

**The first attempt failed and its cause is undetermined.** It failed inside the Android View and
Control lane with exit 1, after the gateway install and OMP rebuild had already completed. The
failure detail was lost to operator output truncation and is unrecoverable; the two subsequent full
runs passed. Two candidate mechanisms were tested and **disproven**, not assumed:

- *Locked or sleeping device.* The smoke's Android lane never wakes or unlocks the phone, unlike the
  qualification harness, which does both explicitly. Re-running the whole smoke with the display
  deliberately put to sleep (`mWakefulness=Dreaming`) **passed**, so the missing unlock is not a
  defect this gate depends on.
- *Race against discovery.* `assertEligibleTarget` fetches the session list once with no bounded
  wait, and the gateway only learns of a new host on its next poll. But the smoke already waits up
  to 90 attempts for the fixture to publish before invoking the lane, so the window is closed.

No fix is claimed, and the cause is recorded as undetermined rather than attributed to a mechanism
that testing ruled out. The gate itself passed twice, including once adversarially.


## Mainline v0.4.1 — published stable

**Updated:** 2026-09-22. **Decision: GO for stable v0.4.1** on the exact matrix recorded under
the 0.4.1 engineering track below. The seven-lane candidate campaign passed against
`v0.4.1-prealpha.3` with orchestrator `6160ff7`.

**Qualified candidate:** [v0.4.1-prealpha.3](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.1-prealpha.3).<br>
**Candidate source:** `e9c70d922337096b706a69108fb93cc539449c8d`.<br>
**Candidate archive SHA-256:** `0ae48db3db7d178bf17c7f60a861d63bb8730ad054fc7f3dc96cc3db2a39eccf`.<br>
**Rollback predecessor:** published stable `v0.4.0`.

**What this release changes for a user:** Apple Web Push no longer fails outright — the VAPID `sub`
contact is a reachable repository URL rather than a reserved `.invalid` address — and an open
software keyboard no longer hides the collaboration composer. A Windows-only ACL change also lands,
on a platform that stays unqualified and unadvertised.

**Limits, unchanged from v0.4.0:** eight-hour endurance is NOT rerun and is NOT CLAIMED; the
founder-approved 1,800-second relay check stands in for it and residual prolonged-operation risk is
accepted. There is no bounded-memory-growth claim. Windows OMP, background Web Push, specialized
attention and branch/resume matrices, iOS, Safari, WebKit, and broader host/browser combinations
remain unqualified.

### Publication — verified 2026-09-22

**Published stable:** [v0.4.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.1),
immutable GitHub Latest at **11:33:44 UTC**, six assets.<br>
**Stable source:** `41a7570008b2e407e023bec129adf117fa63ca05`.<br>
**Stable archive SHA-256:** `3f9154782112731715f35d077863981b4f9a5f590c45e8a8cfb3db78dcdd64c0`.<br>
**Release run:** [`35722047871`](https://github.com/alphastorm/omp-session-gateway/actions/runs/35722047871), passed.

Verified after publication against the downloaded assets, not the workflow log: the archive digest
matches its `SHA256SUMS` entry, `gh attestation verify` accepted it, and `release-info.json` reports
`0.4.1`, the source commit above, and qualified-stable status.

**Runtime byte comparison: passed.** A local build of the promotion tree reproduced the qualified
candidate across **all 46 non-metadata files, with zero differences**; `release-info.json`,
`SBOM.spdx.json`, `STABLE_RELEASE.lock.json` and the stable schema are excluded, matching the
publication gate. A build of the frozen candidate commit also reproduced the published candidate
archive SHA-256 exactly. The comparison requires the pinned Bun on `PATH`, not merely as the invoked
binary: `release:build` spawns the web build through a nested `bun`, and a newer bundler changes
minified identifiers without any source drift.

**Published-byte local installation:** the workstation gateway was upgraded to the published
`0.4.1-dad1e6490817`; `doctor` passed **18/18** and status reported installed, active, ready and
not diverged.

### Post-release smoke — passed 2026-09-22

`bun run smoke:release --tag v0.4.1 --rebuild-omp` passed against the published digest on the
configured Darwin-arm64 workstation and the physical Pixel:

- exact tag, source commit `41a7570`, archive `3f915478…`, and application asset
  `/assets/app.e57732a82351.js` bound to the published release;
- gateway reinstall not required, **configuration and readiness-token bytes preserved**, `doctor`
  **18/18**;
- Tailscale Serve unchanged with unrelated mappings preserved;
- mainline OMP **18.1.20**, binary `b3718d4e…`;
- physical Pixel: View read-only, Control writable, capability sinks clean, same-page recovery, and
  the installed WebAPK launch.

**The first attempts failed, and the cause was the smoke, not the release.** It resolved `omp` from
`PATH` and accepted it on version alone. On this workstation `omp` is a Code Mode launcher that
reports a compatible `18.2.8` while resolving to a different product carrying trusted extensions and
a routed config. The smoke therefore ran the entire physical-client acceptance against that agent,
which never echoed the submitted prompt into the transcript, and failed at `Control prompt
acceptance did not become ready` — a symptom that named nothing.

A version banner cannot establish product identity; the symlink-resolved path can. The smoke now
requires the mainline npm package `UPSTREAM.lock.json` names and refuses anything else with a
message that says so, so a release can no longer be qualified against a derivative build that merely
looks version-compatible. Product identity is checked separately from version compatibility, so
neither can mask the other. No capability was exposed during diagnosis; that stage suppresses its
output by design and the reproduction was redacted.

## Mainline v0.4.0 — published stable

**Updated:** 2026-09-14. **Decision: GO for stable v0.4.0** on the exact matrix below.
The seven-lane candidate receipt completed at **13:05:26.972 UTC**. Stable v0.4.0 was published
at **13:34:03 UTC** as immutable GitHub Latest. Published-byte local installation and the
complete local/physical-Android post-release smoke passed.

**Published stable:** [v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0).<br>
**Stable source:** `7fc85ca00644711f0d7390efc8ec0c438ec2511a`.<br>
**Stable archive SHA-256:** `6e8548b593cb6504e1bf75694a0b97777e223fdb14e270390bef1ecfcfaa596c`.<br>
**Stable release run:** [34849943386](https://github.com/alphastorm/omp-session-gateway/actions/runs/34849943386), passed.
All six published asset digests, three GitHub attestations, three Sigstore bundles, signed tag,
and release identity were independently verified after publication.

**Qualified candidate:** [v0.4.0-prealpha.1](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0-prealpha.1).<br>
**Candidate source:** `cd796a7f2c4ea98f8d8bedafb3b6ff24b6e44221`.<br>
**Candidate archive SHA-256:** `90a2037b75272ddb70a1965f771494abdf32906163846a0c14f4d93b8fc7181c`.<br>
**Signed release run:** [34829484922](https://github.com/alphastorm/omp-session-gateway/actions/runs/34829484922), passed.<br>
**Gateway rollback predecessor:** published v0.3.0, retaining its own fork-era OMP prerequisite.

Stock mainline OMP **>=18.1.20** is the integration prerequisite. The exact qualified host is
**OMP 18.1.20**, source `1bd60c6fbd0e800a75fd09b1e4804af5a5e6d63b`, with **Bun 1.4.0**.
[PR #11908](https://github.com/can1357/oh-my-pi/pull/11908) supplies discovery/query upstream;
no gateway-specific OMP build or gateway publisher credential is required. The gateway reads
metadata and fetches each View/Control capability only at launch, without storing it.

### Exact signed-candidate evidence

- **Artifacts:** signed tag, all six published asset digests, archive/SBOM checksums, three GitHub attestations, and three
  Sigstore bundles verified independently.
- **Debian 13 (trixie) x86-64**, Linux 6.12.94+deb13-amd64: signed-artifact lifecycle,
  **69/69** migration/recovery invariants, stock OMP generation-1 View/Control publication and
  revocation, reboot persistence, tagged-identity denial/exposure, and uninstall passed in
  [run 34830668687](https://github.com/alphastorm/omp-session-gateway/actions/runs/34830668687).
  Droplet and ephemeral SSH-key destruction passed. Its early doctor snapshot was 13/18 before
  OMP installation and from a tagged caller; it is not an all-green doctor claim. Positive
  allowed-user HTTPS access was measured on the retained Mac and Pixel, not that tagged CI caller.
- **Mac14,3 / macOS 26.6.1 arm64:** doctor **18/18**, rollback **23/23**, install/rotation,
  reboot-to-console-login persistence, allowed-user HTTPS, forged-header behavior, and direct
  tailnet/public-backend refusal passed. The exact source/native-addon build was verified.
- **Pixel 10 Pro / Android 17**, build **CP2A.260805.005**, **Chrome 152.0.7977.82**:
  View read-only, Control writable, prompt acceptance, and return to directory passed. Same-page
  unlock, Airplane, and forced-Doze recovery measured **10,398 / 16,821 / 8,475 ms** respectively.
  All **seven** forbidden capability sinks were proven detectable and clean. The application
  asset was `/assets/app.e57732a82351.js`.
- **Live OMP query/launch:** generation-1 View and Control returned 200 with no-store responses;
  the owned session revoked after shutdown. A separate live generation-1-to-2 stale request
  returned **409**, no-store, without a capability at 13:02:07.920 UTC.
- **Relay:** **1,800 seconds**, 11:04:50.160–11:34:50.200 UTC, **two transitions**, final phase
  **live**. The supervised phone-independent runner exited 0 with no restarts.
- **Final cleanup:** zero gateway processes, zero gateway listeners, and zero owned OMP hosts
  on the retained Mac. Its ordinary installed stock OMP prerequisite is intentionally retained.

The receipt is `~/.local/share/omp-session-gateway/qualification/v0.4.0-prealpha.1/stable-qualification.json`,
bound to orchestrator `cd796a7f2c4ea98f8d8bedafb3b6ff24b6e44221` and predecessor v0.3.0.
The host/relay portion used the unchanged lane implementations through a disposable phone-independent
scheduler while Android was held; its archived source digest is
`d38c2670d3a25d3d6a241cb4de40e669d1c3cb450684f7a80b3f15907e2f6e19`.
The standard orchestrator then resumed Android and final cleanup without redispatching Debian,
repeating Mac lifecycle, or rerunning the relay. The scheduler source and metadata-only
`stale-generation-smoke.json` are retained beside the receipt, not installed product machinery.

### Runtime equivalence and release checks

A local build of the frozen candidate reproduced the **entire published archive SHA-256**.
The harness-only OMP banner repair at `e8c1f02485908e0fa6e681b8778d0a384fd8b4cc` also matched
all **46** non-metadata archive files by name, bytes, and mode. Only `release-info.json`,
`SBOM.spdx.json`, `STABLE_RELEASE.lock.json`, and `schemas/stable-release.schema.json`
are excluded, matching the publication gate. The final promotion source `7fc85ca00644711f0d7390efc8ec0c438ec2511a`
passed that same 46-file comparison. Its Bun 1.4.0 build with `OMP_RELEASE_CHANNEL=stable` also
reproduced the **entire published stable archive SHA-256** above. Required checks passed for
[PR #169](https://github.com/alphastorm/omp-session-gateway/pull/169), the narrow
[PR #170](https://github.com/alphastorm/omp-session-gateway/pull/170) repair, and
[PR #171](https://github.com/alphastorm/omp-session-gateway/pull/171) qualification approval;
the signed stable release workflow passed its publication gates.

The first Mac attempt exposed a missing ordinary OMP installation: the same stopped candidate's
compatibility check changed from false to true after installing stock OMP 18.1.20. A subsequent
SSH failure occurred before rollback staging; its cause remains undetermined. The isolated
rollback probe then passed 23/23, followed by the complete Mac lane. Cleanup passed after both
failed attempts. No replacement candidate or duplicate Debian dispatch was used.

### Published-byte local installation and Android smoke

The configured local Darwin-arm64 gateway was upgraded from v0.3.0 using its matching signed
CLI to uninstall the old service before installing the verified published v0.4.0 payload.
The private configuration remained byte-for-byte unchanged in place; no credential bundle was
copied. The retired publisher token was removed and a private readiness token created.
The managed service is installed, active, ready, and non-diverged; doctor passed **18/18**.
It uses the persistent Bun **1.4.0** runtime. The existing local OMP **18.1.21** was retained,
not rebuilt or replaced; this local check does not expand the exact OMP 18.1.20 qualification matrix.

The first full post-release smoke stopped at Android View/Control. An isolated probe observed
View succeed, followed by Control returning to the directory. Four subsequent instrumented
owned-fixture probes and one unchanged Android-stage run passed View, Control, prompt acceptance,
and return. All owned fixtures were cleaned. **The initial failure cause remains undetermined;
no product-code fix is claimed.** The full published-byte smoke was then restarted from that
passing narrow boundary, without clearing browser storage or changing the published runtime.

The complete unchanged `bun run smoke:release` run for `v0.4.0`, bound to the
published digest above, then **passed with exit 0** in **4 minutes 19 seconds** with no supervisor
restarts. It verified the exact published provenance and application asset, reused the already
installed stable gateway, preserved configuration/readiness-token bytes and unrelated Serve
mappings, and passed doctor **18/18**. Serve required no change. On the physical Pixel, View
read-only, Control writable, capability-sink checks, same-page recovery, and installed-WebAPK
checks passed. The existing OMP **18.1.21** binary digest was
`7a14ea7dab973cb2a3b948ffd8aac33cdb9b662a0d9ca8163c412cd3072ada5a`; OMP was not reinstalled.
Owned fixture and private staging cleanup completed before success was returned. Gateway, OMP,
and WebAPK remain installed. The native metadata-only result is retained as
`published-v0.4.0/post-release-smoke.json` beside the candidate receipt. This passing run does
not establish the cause of the earlier intermittent Control-upgrade failure.

### Assurance boundary

**Founder-approved amendment, 2026-09-14:** the fresh 30-minute check replaces the eight-hour gate
for v0.4.0 only; every other release gate remains intact. **Eight-hour endurance was NOT RERUN
and is NOT CLAIMED.** Residual prolonged-operation risk is accepted; no fork-era result transfers.
There is no bounded-memory-growth claim. Windows OMP, background Web Push, specialized attention
and branch/resume matrices, and broader host/browser combinations remain unqualified.

## 0.4.1 engineering track — unqualified

The development gateway version is `0.4.1`. Published stable `v0.4.0` remains GitHub Latest,
the advertised release, and the only qualified artifact; nothing below widens its claim.

### v0.4.1-prealpha.1 — published engineering candidate for external push verification

**Source:** `cd7d83e7be3a152891333f0fbda100544605f896`.<br>
**Archive SHA-256:** `8b33baebda87217bf5021648c370c6a1b801031fdfc47fed9474d2e48be2f3f7`.<br>
**Release run:** [`35292381016`](https://github.com/alphastorm/omp-session-gateway/actions/runs/35292381016), passed; published 2026-09-18 at 00:44:28 UTC.<br>
**Classification:** signed pre-alpha prerelease, immutable, not Latest, unqualified on every host
and client. Stable `v0.4.0` remained GitHub Latest after publication.

**Purpose:** let the reporter of [#173](https://github.com/alphastorm/omp-session-gateway/issues/173)
verify the Web Push fix against Apple's push service from published, signed bytes. The change is
one constant: the VAPID `sub` contact moved from a reserved `.invalid` `mailto:` address, which
Apple rejected with `403 BadJwtToken`, to the repository URL. The regression test pins the
transport-observed contact; the real `web-push` signer places the URL in the JWT `sub` claim.

The release published six assets. The immutable-release attestation, all six asset digests,
`SHA256SUMS`, three GitHub build attestations, and three Sigstore bundles verified against the
signed tag and `signed-release.yml` identity after publication. The downloaded archive's
`release-info.json` reports `0.4.1`, the source above, and pre-alpha qualification; its bundled
CLI carries the repository-URL contact and no `.invalid` string.

No host, physical-client, relay, migration, or rollback lane has run against these bytes. A
successful external report is one anecdote from an unadvertised iOS/Ubuntu combination, not iOS
support; background Web Push stays outside the stable core claim.

### v0.4.1-prealpha.2 — published engineering candidate for external software-keyboard verification

**Source:** `5fa3e361bd087ff2b53f03b5f0906c9e1bc9b016`.<br>
**Archive SHA-256:** `ed63761375f1ae49427da3426cc82e4ee2b2ab1842395b8c0866e0b00fb24d95`.<br>
**Release run:** [`35682557336`](https://github.com/alphastorm/omp-session-gateway/actions/runs/35682557336), passed; published 2026-09-22 at 03:17:33 UTC.<br>
**Classification:** signed pre-alpha prerelease, immutable, not Latest, unqualified on every host
and client. Stable `v0.4.0` remained GitHub Latest and the only qualified artifact after
publication.

**Purpose:** let the reporter of [#189](https://github.com/alphastorm/omp-session-gateway/issues/189)
verify the software-keyboard fix from published, signed bytes rather than a source checkout. The
change is two CSS declarations: `body.collab-shell-active` and `.gateway-shell` size from
`var(--viewport-height, 100dvh)` instead of `100dvh`, so the gateway chrome follows the same
visual-viewport measurement the mounted collaboration client already publishes. A browser test
drives a shrinking visual viewport and asserts the composer's bottom edge stays inside it; it fails
without the change.

This candidate also carries the shared browser-test transport helper and the continuous-integration
lane documentation from [#194](https://github.com/alphastorm/omp-session-gateway/pull/194), neither
of which changes shipped bytes.

The release published six assets. The downloaded archive reproduced the published asset digest and
its `SHA256SUMS` entry exactly. The immutable-release attestation covers all six assets, and one
SLSA provenance statement covers the archive, SBOM, and `SHA256SUMS`; both are bound to
`refs/tags/v0.4.1-prealpha.2` at the source commit above, and `gh attestation verify` accepted the
archive. The archive's `release-info.json` reports `0.4.1`, that source commit, and pre-alpha
qualification, and its built stylesheet carries the two `var(--viewport-height, 100dvh)` chrome
declarations that constitute the fix.

No host, physical-client, relay, migration, or rollback lane has run against these bytes. The
reporter's earlier confirmation was made on an unsigned source-checkout install of the fix branch;
it is one anecdote from an unadvertised iOS client, not iOS support and not a qualification result.
iOS, Safari, and WebKit remain outside every row of `docs/COMPATIBILITY.md`.

### v0.4.1-prealpha.3 — qualified stable candidate

**Source:** `e9c70d922337096b706a69108fb93cc539449c8d`.<br>
**Archive SHA-256:** `0ae48db3db7d178bf17c7f60a861d63bb8730ad054fc7f3dc96cc3db2a39eccf`.<br>
**Release:** [v0.4.1-prealpha.3](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.1-prealpha.3), six assets, immutable prerelease.<br>
**Qualification orchestrator:** `6160ff722c8f848e50f3d195830828ff14f9ea2b`.<br>
**Classification:** signed pre-alpha prerelease, not Latest. The seven-lane campaign passed against
these exact bytes on the matrix below; stable `v0.4.0` remains GitHub Latest until promotion.

**Contents beyond stable `v0.4.0`.** Three behaviour changes, no more: the VAPID `sub` contact is
the repository URL instead of a reserved `.invalid` address; the gateway chrome sizes from the live
visual viewport instead of `100dvh`; and Windows private-path ACL checks are served by one
long-lived helper rather than one process per path. The first two are qualified-platform changes,
the third executes only on Windows, which remains unqualified and unadvertised.

**Rollback predecessor:** published stable `v0.4.0`. The orchestrator previously pinned `v0.3.0`,
which would have installed a superseded stable as the upgrade source and rollback target on both
the Debian and macOS lanes; corrected before the campaign was dispatched.

**Assurance boundary — founder-approved amendment, 2026-09-22.** The 2026-09-14 amendment replacing
the eight-hour endurance gate with the fresh 1,800-second relay check was scoped to `v0.4.0` only.
It is approved again for `v0.4.1` on the exact delta above: one constant and two CSS declarations
carry no prolonged-operation behaviour, and the single long-lived subprocess this candidate adds
runs only on Windows, which the endurance lane does not exercise. **Eight-hour endurance is NOT
RERUN and is NOT CLAIMED for v0.4.1.** Residual prolonged-operation risk is accepted and there is
no bounded-memory-growth claim. Every other release gate remains intact.

### Seven-lane campaign — passed 2026-09-22

- **Artifacts:** signed tag, published asset checksums, **3/3** GitHub attestations and **3/3**
  Sigstore bundles verified against the candidate release.
- **Debian 13 x86-64** disposable droplet, [run 35715529188](https://github.com/alphastorm/omp-session-gateway/actions/runs/35715529188):
  artifact lifecycle, installed-service contracts, mainline OMP publication, and the explicit
  upgrade/rollback pair from published `v0.4.0`. Droplet and ephemeral SSH key destroyed.
- **Mac14,3 / macOS 26.6.1 arm64:** `doctor` **18/18**, rollback invariants **23/23**, exact
  archive and native-addon digests verified.
- **Live OMP publication:** generation-1 View and Control both returned **200** with `no-store` and
  a capability present; the owned session was revoked afterwards.
- **Pixel 10 Pro / Android 17** build `CP2A.260805.005`, **Chrome 153.0.8010.52**: View read-only
  and Control writable against the qualified host. Same-page unlock **8,983 ms**, Airplane recovery
  **16,657 ms**, forced-Doze recovery **8,337 ms**. Application asset `/assets/app.e57732a82351.js`.
- **Relay:** **1,800 seconds**, 10:34:00–11:04:00 UTC, **two transitions**, final phase **live**.
- **Cleanup:** zero gateway processes, zero gateway listeners, zero live OMP hosts.

**Qualification-harness corrections made during this campaign.** The first three dispatches failed
on the harness, not the candidate, and every failure was a fork-era assumption exposed by moving the
predecessor from `v0.3.0` to `v0.4.0`: Lane 4 hashed a retired publisher credential that a mainline
predecessor never mints; every predecessor default across the droplet workflow, the Linux lane, the
macOS host script and the rollback harness still named the superseded stable; and Lane 4 asserted
that an old installer and both rollback selections must *refuse*, which was true only across the
fork-era boundary. That lane now qualifies the compatible path instead — the predecessor installer
takes over a running candidate and each rollback selection activates the predecessor, preserving
configuration and the readiness credential. A separate defect made the Android lane wait on the
browser process leaving `CACHED_EMPTY` rather than on DevTools accepting connections. None of these
changed candidate bytes; the passing run used orchestrator `6160ff7` throughout, and the receipt
refuses to resume evidence across orchestrator commits, so no lane result was carried over a fix.

## Fork-era release and qualification archive

**Every result, support decision, prerequisite, command, and “current” label below belongs to its
named fork-era snapshot**, including the 2026-09-09 stable decision, post-release smoke, source
checks, all candidate lanes, and older limitations. Exact dates, commits, hashes, counts, failures,
and approval history are preserved. Patch paths and configuration references resolve at the named
historical tag, not this checkout. They no longer describe the shipping prerequisite.


**Updated:** 2026-09-09<br>
**Repository version:** `0.3.0`<br>
**Qualified stable candidate:** **`v0.3.0-prealpha.3`**, independently verified<br>
**Classification:** published immutable GitHub Latest v0.3.0, qualified on the exact combinations below<br>
**Stable decision:** **GO for v0.3.0**, using exact patched OMP v18.1.14 and Bun 1.4.0, with no
historical qualification transfer or broader platform claim.

### Stable v0.3.0 — published

**Release:** [v0.3.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.3.0),
published 2026-09-09 at 23:39:08 UTC as immutable, non-prerelease GitHub Latest with six assets.<br>
**Signed source:** `8a699ee3446b2aa7a6db9243e525e549040dca1c`.<br>
**Archive SHA-256:** `e026cb5c437793dbe7813e028d8344ef7fa1724cdd388263aabe6cb3c43ac975`.<br>
**Release run:** [34417806278](https://github.com/alphastorm/omp-session-gateway/actions/runs/34417806278), passed.

The published-archive post-release smoke passed on the configured Darwin-arm64 workstation and
physical Pixel. It verified release provenance and the exact source/archive/application asset,
reused the already exact gateway and patched OMP v18.1.14, passed doctor 17/17, and preserved
config, publisher-token bytes, and all Serve mappings. Physical View/Control, prompt/interrupt,
forbidden capability sinks, same-page lock/Airplane/Doze recovery, installed-WebAPK launch, owned
session revocation, and staging cleanup passed. The gateway, patched OMP, and WebAPK remain
installed. This named post-release smoke does not broaden the qualified platform matrix.
Metadata-only output is `post-release-smoke.json` beside the candidate qualification receipt below.

The first post-release run stopped at a harness assertion: Android correctly resumed an existing
`/client/` page with its session-specific title, while the check required the directory title.
The corrected check accepts only the exact origin and capability-free application routes. A
regression failed before the fix and passed afterward; a direct physical launch proved the resumed
route, then the complete corrected smoke passed. Published runtime bytes were unchanged.

Stable **v0.3.0** uses published `v0.3.0-prealpha.3` as its signed qualification candidate with Latest disabled.
Release run [34254684458](https://github.com/alphastorm/omp-session-gateway/actions/runs/34254684458)
passed at source `2c89d8280059a2bb638901d413df44b35593ddd4`. Archive SHA-256:
`05c8a8f4001612d7e10c52139bf5b7aa53dca42e64fa2c262592cf6c4d932ec5`.
The independent artifact lane verified the signed tag, six asset digests, checksums, three GitHub
attestations, and three Sigstore bundles. Stable `v0.2.1` is the rollback predecessor.

**Current decision: GO.** The seven-lane signed-candidate matrix, independent 28,800-second
endurance run, provenance verification, and runtime-byte comparison all passed. The stable lock
binds v0.3.0 to this candidate and the v0.2.1 rollback predecessor. The release workflow
rechecked GitHub Latest and final runtime equivalence before publishing.

The signed-candidate receipt at
`~/.local/share/omp-session-gateway/qualification/v0.3.0-prealpha.3-8g/stable-qualification.json`
completed on 2026-09-08 at 17:59:07 UTC, bound to orchestrator
`cfbba3ca78bf94555a916bc53143335d6b030d39` and predecessor `v0.2.1`:

- Debian 13 x86-64 passed the complete disposable-host lane in
  [run 34258230589](https://github.com/alphastorm/omp-session-gateway/actions/runs/34258230589),
  including the predecessor upgrade/rollback pair and paid-resource teardown.
- `Mac14,3` / macOS 26.6.1 arm64 passed `doctor` 17/17, rollback invariants 20/20,
  persistence, exact artifact/native-addon checks, exposure/identity checks, and uninstall.
- Pixel 10 Pro / Android 17 build `CP2A.260805.005` / Chrome `152.0.7977.75` passed
  View/read-only, Control, prompt acknowledgement, and same-page lock (9,451 ms), Airplane
  (8,481 ms), and forced-Doze (8,799 ms) recovery. All seven forbidden capability sinks were
  detectable and clean. The exact application asset was `/assets/app.32115375c6b5.js`.
- Exact patched OMP v18.1.14 published generation-1 View and Control with `200 no-store`,
  then revoked the owned session. The 60-second default-relay smoke finished live with two
  transitions. Final cleanup measured zero gateway processes/listeners and zero patched-OMP
  processes on the retained Mac.
- An offline prospective stable build at `ca6c2f7213e9d8ad5d3c46e2277b919138a60483` matched
  all 49 non-metadata candidate archive files by name, bytes, and mode. Only `release-info.json`,
  `SBOM.spdx.json`, `STABLE_RELEASE.lock.json`, and `schemas/stable-release.schema.json` are
  excluded, matching the publication gate. The final promotion tree and release workflow also
  passed this comparison before publication.

Additional signed-byte physical media smoke on 2026-09-09 used the installed WebAPK on the same
Pixel after Chrome updated to `152.0.7977.82`. The native Google Camera captured one authorized
covered-lens photo; the composer normalized it to 1,542 × 2,048, sent it with a synthetic note,
observed the host transcript acknowledgement, and cleared the draft without changing
`performance.timeOrigin`. The native `com.google.android.photopicker` opened and was canceled
without selecting personal media. No model-analysis claim is made: the synthetic credential
produced the expected authentication error after delivery. This is a named media smoke, not a
transfer of the `.75` full matrix to `.82`. The owned page, ADB forward, process, and workspace
were removed; metadata-only evidence is `pixel-camera-smoke.json` beside the matrix receipt.

The first Debian run [34254831201](https://github.com/alphastorm/omp-session-gateway/actions/runs/34254831201)
failed when upstream coding-agent `tsgo` was killed (exit 137) on the 4 GiB host. Droplet and
ephemeral SSH-key teardown passed; no Mac lane began. The unchanged exact patched OMP/Bun check
then passed in a two-CPU local Linux container capped at 6 GiB, with peak memory 4,186,173,440 bytes
and no OOM events. Qualification defaults now reserve 8 GiB on two CPUs; the 50-minute deadline
and always-run teardown remain unchanged. This is a tooling correction, not changed candidate bytes.

The first retained-Mac pre-cleanup then correctly refused a dangling qualification symlink to
`v17.4.1-a5cfc80f/omp`. Its exact target, current-user ownership, and absent destination were
verified before removing that link only. Direct cleanup passed, and the same receipt resumed
without redispatching Debian. A separate Windows CI timeout was closed by reusing one private
token fixture and removing a redundant privacy read, not widening the timeout; all checks passed
in [run 34324545432](https://github.com/alphastorm/omp-session-gateway/actions/runs/34324545432).

The fresh endurance run passed **28,800 seconds**, from 2026-09-09 07:48:21 to 15:48:23 UTC,
with six phase transitions, `finalPhase: "live"`, exit 0, and no process restart. It used the
signed candidate gateway, exact patched OMP v18.1.14, Bun 1.4.0, one synthetic host, and idle-sleep
inhibition on `Mac16,5` / macOS 26.6.2 arm64 (Darwin 25.6.0). The client was the pinned
`GuestClient` under Bun, not an emulated browser. This endurance environment adds no host/browser
support claim to the separately qualified Mac14,3/Pixel matrix.

The same gateway PID's RSS moved from 44,880 to 57,792 KiB (43.8 to 56.4 MiB). These are measured
start/end values under ordinary workstation traffic, not an isolated heap-leak proof. The
state-faithful 60-second preflight passed before the long run. The owned host and workspace were
removed after completion; the sleep inhibitor exited with the runner. Evidence beside the matrix
receipt: `relay-soak-8h.json`, `relay-soak-bindings.json`, and the supervised process's final JSON.
The earlier harness-timeout interruption remains in `relay-soak-interrupted-launch.json` and is
not qualification evidence.

## Historical records

All remaining entries describe their named historical snapshots. They neither change the v0.3.0
decision above nor transfer qualification to its new OMP baseline.

### Prequalification source checks

The current `0.3.0` source targets upstream `v18.1.14` at
`daf07999c2fee9b22edc7bf8fea1fb6272e0df5e` with its exact gateway patch and pinned browser
client. The published candidate does not inherit the historical stable matrix. Prior engineering
and stable artifacts retain their original v17.4.1 OMP baselines unchanged.

Initial Darwin arm64 engineering proof on 2026-09-08: the exact mbox reconstructed patched tree
`17f84676442ee103564d01755ed1f76bbc51820e`; 138 focused OMP tests and upstream
`bun run ci:check:full` passed under Bun 1.4.0. Gateway `bun run check` passed in a clean
source snapshot (522 tests, both leak scans); all 24 browser regressions passed. A real patched-host
fixture proved View/read-only, native MathML, retained Ask confirmation with host acknowledgement,
relay reconnect, and publisher removal. The browser URL stayed query/fragment-free, cookies were
empty, storage held only the existing guest-name preference, and caches held four immutable shell
assets. No provider call or live transcript inspection was used. These checks do not qualify Linux,
Windows, physical Android, background Push, or a stable release.

Subsequent prequalification fixes preserve custom managed-upgrade configuration, remove the
unshipped standalone bootstrap that polluted React tests, and derive Mac checks from the exact OMP
pin. The config regression reproduced a reset and malformed-file overwrite, then passed 67 config
tests, 44 CLI tests, and an isolated real systemd install. The bootstrap order regression reproduced
12 failures, then passed all 65 remaining client tests and four installed-PWA/BFCache browser cases.
The stable matrix now also exercises physical View/Control and prompt acknowledgement before its
forbidden-sink sweep. These source checks preceded the signed-candidate results above.

The prepublication council also identified browser-normalized unsafe Markdown links, a broken
provenance-rehearsal tag parser, stale prerelease notes, and dangling Mac cleanup symlinks.
The Markdown regression failed before correction and passed afterward; real Chromium rendered the
unsafe label without a link while retaining an ordinary HTTPS link. Physical Pixel 10 Pro /
Android 17 / Chrome 152.0.7977.75 preflight opened both the native Google Camera capture activity
and system PhotoPicker, canceled each, and retained usable Control input. No photograph was taken,
selected, or uploaded. This source-built preflight is not signed-candidate qualification.

The source-built gateway then activated locally as `0.3.0-3d42814812ff` under persistent Bun
1.4.0. Status was active/ready/non-diverged and doctor passed 17/17. Config, publisher-token,
Tailscale Serve, and ordinary `omp` bytes/selection were unchanged; the existing live publisher
repopulated. The verified predecessor `0.3.0-d259ea06c7fe` remains the recorded rollback target
(lookup checked without activating rollback). `omp-gateway-patched` now runs the exact v18.1.14
binary, SHA-256 `b0c0f6f80021241df931724fa82d146c814028a3bd8a270aeca64f4d52bfdf13`, with
source retained at `~/src/oh-my-pi-gateway-v18.1.14`; the old patched binary remains available.
The installed pair also passed a synthetic Ask acknowledgement and MathML flow through the real
Tailscale Serve origin, followed by publisher removal. No public release was created.

### 0.3.0 engineering track — unqualified

Published engineering release `v0.3.0-prealpha.2` adds an explicit direct-camera versus
existing-photo choice to the bounded phone photo composer introduced in `v0.3.0-prealpha.1`.
It uses the existing encrypted OMP v3 image-prompt frame and does not change gateway IPC/HTTP,
capability handling, the controller/publisher patch, or `COLLAB_PROTO`. No 0.2.1 qualification
evidence transfers to these changed client bytes. The exact source, archive, local activation, and
real patched-host browser flow are recorded below; the physical Pixel camera chooser and the full
qualification matrix have not run. The release remains pre-alpha and cannot replace or widen the
stable support claim below.

### v0.3.0-prealpha.2 — published direct-camera follow-up

**Source:** `a9ef7e03934986bf9a3ecc12eb87a707d35e846b`.<br>
**Archive SHA-256:** `ca05549aecdf0d2e01f2b5d6820729222e29b38e92aa4ee1582c009e195c6fff`.<br>
**Release run:** [`33283594409`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33283594409), passed.<br>
**Classification:** published immutable prerelease, not Latest; the exact local smoke below does
not transfer stable qualification.

The release published six assets. Checksums, all immutable asset digests, three GitHub build
attestations, and three Sigstore bundles verified against the signed tag. The published archive
installed under pinned Bun 1.3.14 as `0.3.0-d259ea06c7fe`; config and publisher-token bytes were
unchanged, `status` was active/ready/non-diverged, and `doctor` passed 17/17.

An owned exact patched-OMP v17.4.1 fixture proved the activated released client kept Photo disabled
in View, upgraded to Control, and rendered two 56px Pixel-width choices without overflow.
**Take photo** targeted the dedicated `capture="environment"` input; **Choose existing** targeted
the no-capture input. Synthetic camera-JPEG and existing-photo PNG sends both traversed the default
relay, received exact host transcript acknowledgement, rendered two transcript images, and cleared
their drafts. Fixture revocation and scoped cleanup passed.

No physical ADB device was attached. The native Android camera application launch remains the one
unobserved handoff; the activated release now exposes that path for the user's direct Pixel test.

### v0.3.0-prealpha.1 — published engineering release

**Source:** `790658ee914658d742ff0b369fd6b33b78efd9ea`.<br>
**Archive SHA-256:** `60750b2b5f21d4e99dbd1a4d05230f4aa3f4d79b15c113d08aa68042a54c5fed`.<br>
**Release run:** [`33281549543`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33281549543), passed.<br>
**Classification:** published immutable prerelease, not Latest; unqualified beyond the exact smoke
below. Stable `v0.2.1` remains GitHub Latest and the 0.3.0 rollback/qualification predecessor.

The release published six assets. `SHA256SUMS` verified the archive and SPDX document; all six
immutable asset digests, three GitHub build attestations, and three Sigstore bundles verified
against the signed tag and `signed-release.yml` identity.

The published archive installed on the configured Darwin arm64 workstation as
`0.3.0-1a8a3212e195` under pinned Bun 1.3.14. Private config and publisher-token SHA-256 values
remained byte-identical, `status` reported active/ready/non-diverged, and `doctor` passed 17/17.
An owned exact patched-OMP v17.4.1 fixture published View and Control through the default relay.
The released client proved View disabled the photo path, upgraded to Control, normalized and sent a
2,048px captioned desktop image and a 2,048px image-only Pixel-viewport image, received byte-exact
host transcript acknowledgement, cleared each retained draft, rendered transcript images within
the viewport, and showed no horizontal overflow. Fixture revocation and scoped cleanup passed.

The measured `411 × 816` Pixel layout and desktop Chromium surface are smoke evidence only. No ADB
device was attached, so physical camera/photo chooser behavior, Android process lifecycle, and the
full forbidden-sink sweep remain unproven for these exact bytes.

Candidate `v0.2.1-prealpha.1` built, attested, and signed successfully, then failed closed while
validating its draft because `release-state.ts` still expected `0.2.0` asset names. The workflow
deleted the draft; the signed tag and transparency records remain diagnostic evidence. Candidate
`v0.2.1-prealpha.2` derives the six expected assets from the validated tag version and is the only
0.2.1 candidate eligible for qualification.

### Stable 0.2.1 — GO

**Target tag:** `v0.2.1`, published as a non-prerelease GitHub Latest release and now immutable.<br>
**Published source:** `9efef77820db3d530f54fa89ee9fbac61f13ad3b`.<br>
**Published archive SHA-256:** `337a3b654edb1eb0151377ffc0d41e097fda1a7ca127c1f8c067abb8fa1146b6`.<br>
**Machine gate:** `STABLE_RELEASE.lock.json` is qualified for candidate `v0.2.1-prealpha.2`.<br>
**Candidate source:** `f09e3566c238ad76e220bea093d06d0124f924d9`.<br>
**Candidate archive SHA-256:** `9fd5e49b9819ab4dfc82f978fcd9e8382b83d5b821bb341c6b6e6979ff42c7fa`.<br>
**Rollback predecessor:** published stable `v0.2.0`; Debian and macOS exercised the exact
`v0.2.0 → v0.2.1-prealpha.2` upgrade and rollback pair.<br>
**Support boundary:** unchanged Debian 13 x86-64, macOS 26.6.1 arm64 on `Mac14,3`, Chrome
`151.0.7922.173` on Android 17 / Pixel 10 Pro, TUN-mode Tailscale Serve, and exact patched OMP
v17.4.1 source `9350b7990d26ebf69a604edc82d8558ef04adf30` with patched tree
`a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`. Every prior exclusion remains unchanged.

One resumable orchestrator receipt ran from published `main` at
`d768153610b6f1f43899d1a65e5330ab0396d9ef` and completed `passed` at
`2026-08-28T22:34:56.358Z`:

- release run [`33206359784`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33206359784)
  published six prerelease/not-Latest assets; the signed tag, checksums, three attestations, three
  Sigstore bundles, and exact candidate archive digest above verified;
- Debian run [`33207184350`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33207184350)
  passed the disposable Debian 13 lifecycle and the published `v0.2.0` migration/rollback pair;
- retained `Mac14,3` / macOS 26.6.1 arm64 passed `doctor` 17/17, rollback invariants 20/20,
  persistence, exact archive/native checks, patched-OMP build, uninstall, and cleanup;
- exact patched OMP v17.4.1 published and revoked generation-1 View and Control with `200 no-store`;
- the physical Pixel passed same-page lock, Airplane, and forced-Doze recovery in 9,464 ms,
  8,435 ms, and 8,360 ms respectively; the seven-sink capability sweep was clean;
- the default relay stayed live for 60 seconds with two transitions; and
- final cleanup measured zero gateway processes/listeners and zero patched-OMP processes.

The initial physical-client attempt stopped before device effects because ADB had not yet been
authorized. After explicit authorization, the same receipt resumed without redispatching Debian or
rerunning the passed Mac/relay lanes; Android, OMP publication, and cleanup then passed.

### Stable 0.2.0 — superseded

**Target tag:** `v0.2.0`, published as a non-prerelease and GitHub Latest.<br>
**Machine gate:** `STABLE_RELEASE.lock.json` is qualified for candidate `v0.2.0-prealpha.1`.<br>
**Candidate source:** `db88afb2ca18b0822648012bb6da50fd596f294c`.<br>
**Candidate archive SHA-256:** `149fc1b88a22b9cb1781bcb6219f2c1e41cafc867cb4eefe0a1e04b07eceeea2`.<br>
**Rollback predecessor:** published stable `v0.1.0`; the Mac lane exercised the cross-version
`v0.1.0 → v0.2.0-prealpha.1` upgrade and rollback pair.<br>
**Support boundary:** Debian 13 x86-64, macOS 26.6.1 arm64 on `Mac14,3`, Chrome
`151.0.7922.173` on Android 17 / Pixel 10 Pro, TUN-mode Tailscale Serve, and exact patched OMP
v17.4.1 source `9350b7990d26ebf69a604edc82d8558ef04adf30` with patched tree
`a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`. Windows, stock OMP, background Push, Funnel,
Portal Tunnel, userspace networking, alternate/self-hosted relays, and paired OMP packaging remain
unsupported.

One orchestrator process ran from published branch `main` at
`fb375fad33cba7945e3455a9d43c2fcb30874db7` and wrote the mode-`0600` receipt
`~/.local/share/omp-session-gateway/qualification/v0.2.0-prealpha.1/stable-qualification.json`.
It completed `passed` at `2026-08-28T09:01:38.902Z`; every lane ran exactly once:

- release run [`33155940416`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33155940416)
  published six prerelease/not-Latest assets; the signed tag, checksums, all six GitHub asset
  digests, three GitHub attestations, and three Cosign bundles verified against the exact
  candidate archive SHA-256 above;
- Debian run [`33156664373`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33156664373)
  passed the full disposable-host lifecycle on Debian 13 (trixie), kernel `6.12.94+deb13-amd64`,
  systemd 257, including the cross-version `v0.1.0` predecessor migration lane, and destroyed its
  droplet and ephemeral SSH key;
- retained `Mac14,3` / macOS 26.6.1 arm64 passed `doctor` 17/17, rollback invariants 20/20,
  persistence, exact archive/native checks (archive equal to the candidate digest; native addon
  `7fd4e3f822ff5b1fb890c27ec8a7e19166902f70c81eb4d303061fefe26766f1`), patched-OMP build,
  publication/revocation, uninstall, and Serve/source cleanup;
- the exact patched OMP published generation-1 View and Control, returned `200 no-store`, and
  revoked before cleanup;
- the Pixel 10 Pro (`Chrome 151.0.7922.173`) rendered the same page throughout: lock/resume
  recovered in 8,793 ms, a visible Airplane outage recovered in 8,274 ms, and forced Doze
  recovered in 8,360 ms; the seven-sink capability sweep planted 7, detected 7, and ended clean;
- the default relay stayed live for 60 seconds with two transitions; and
- final cleanup measured zero gateway processes/listeners and zero patched-OMP processes.

The first `v0.2.0-prealpha.1` qualification dispatch failed closed at the Debian preflight
(cross-version predecessor asset naming, fixed in
[#146](https://github.com/alphastorm/omp-session-gateway/pull/146)) without creating a droplet or
touching the Mac; its archived receipt recorded no Mac effects and the passing run above started
from a fresh receipt.

**Known cosmetic defect in the published v0.2.0 archive:** `installation.ts`/`diagnostics.ts`
carry a hardcoded `0.1.0` product constant, so managed-installation directories, `status`
`activeVersion`, and diagnostics bundles from v0.2.0 report `0.1.0-<content-hash>` while running
the exact v0.2.0 bytes. Install/rollback identity binds to the content hash and source commit —
the qualified rollback and post-release smoke lanes passed with the defect present — so the
support claim is unaffected. Fixed on `main` with a version-coherence test; the next release
reports its true version.

### Stable 0.1 — GO

**Target tag:** `v0.1.0`, published as a non-prerelease and GitHub Latest.<br>
**Machine gate:** `STABLE_RELEASE.lock.json` is qualified for candidate `v0.1.0-prealpha.23`.<br>
**Candidate source:** `434cddc443335d6da6476b43564db8230365e6fc`.<br>
**Candidate archive SHA-256:** `f98bad0ce2ae20d3892e560069b2fbfc4ab6d084a403b6aa57e41c628c25ce98`.<br>
**Support boundary:** Debian 13 x86-64, macOS 26.6.1 arm64 on `Mac14,3`, Chrome
`151.0.7922.171` on Android 17 / Pixel 10 Pro, TUN-mode Tailscale Serve, and exact patched OMP
v17.4.1 source `9350b7990d26ebf69a604edc82d8558ef04adf30` with patched tree
`a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`. Windows, stock OMP, background Push, Funnel,
Portal Tunnel, userspace networking, alternate/self-hosted relays, and paired OMP packaging remain
unsupported.

One orchestrator process ran from published branch `qual/stable-prealpha-23-434cddc` and wrote the
mode-`0600` receipt
`~/.local/share/omp-session-gateway/qualification/v0.1.0-prealpha.23/stable-qualification.json`.
It completed `passed` at `2026-08-22T17:16:42.545Z`; every lane ran exactly once:

- release run [`32586209795`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32586209795)
  published six prerelease/not-Latest assets; the signed tag, checksums, all six GitHub asset
  digests, three GitHub attestations, three Cosign bundles, and a clean byte-exact rebuild passed;
- Debian run [`32586459902`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32586459902)
  passed the full disposable-host lifecycle and destroyed its droplet and ephemeral SSH key;
- retained `Mac14,3` passed `doctor` 17/17, rollback 20/20, persistence, exact archive/native
  checks, patched-OMP build, publication/revocation, uninstall, and Serve/source cleanup;
- the exact patched OMP published generation-1 View and Control, returned `200 no-store`, and
  revoked before cleanup;
- the Pixel rendered the same page throughout (`performance.timeOrigin` unchanged): lock/resume
  recovered in 8,972 ms, a visible Airplane outage recovered in 8,998 ms and stayed settled for
  ten seconds, and forced Doze recovered in 8,291 ms; the seven-sink capability sweep was clean;
- the default relay stayed live for 60 seconds with two transitions; and
- final cleanup measured zero gateway processes/listeners and zero patched-OMP processes. Independent
  checks found no qualification-owned DigitalOcean droplet or SSH key, no Mac Serve mapping, and
  restored Pixel radio/Doze state.

A clean stable-channel build and the downloaded `.23` archive contain the same 51 members. All 48
runtime members are byte- and mode-identical with canonical digest
`0673123a1c19a416fb5e6b3000d11ac122d043e9e769b1714cd34f521b4f3535`. The only differences are
the approved `STABLE_RELEASE.lock.json`, source/channel-bound `release-info.json`, and source-bound
`SBOM.spdx.json`; no executable, gateway module, PWA/collab asset, protocol, patch, dependency lock,
license, or integration byte differs.


Two signed predecessors were explicitly rejected rather than promoted:

- `.21` source `a98c526c40a335df49cb679448f51ac631ffc3f2`, archive
  `cb7da13531875b879c3ab1c2451b58683199263877a74475f539258dfdcba33c`, and Debian run
  `32565941928` passed artifact, Debian, macOS, and relay lanes, but its physical Android lane
  failed; cleanup still passed. Its final receipt is archived as
  `v0.1.0-prealpha.21.failed-32565941928-187994c`.
- `.22` source `489b58e4b862d54f13779ecf361b68634f31594b`, archive
  `194958b5b7affce27163145ca90b5cc14c6952ebb0bbf15b43878c351c6c69db`, and Debian run
  [`32579748768`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32579748768)
  passed artifact, Debian, macOS, and relay lanes, but lock/resume never became ready, Airplane
  recovered only after 170,210 ms, Doze never recovered, and no outage status rendered; cleanup
  passed. Its receipt is archived as `v0.1.0-prealpha.22.failed-32579748768-489b58e`.

The `.23` product fix preserves native EventSource reconnection when Android loses a JavaScript
timer while retaining the bounded snapshot fallback. The physical gate observes rendered state
without competing fetches and rejects a page reload. Issue #65 remains a documented Chrome
process-wide limitation outside the proven transitions; the loaded shell still offers bounded
recovery guidance rather than claiming JavaScript can restart Chrome's network service.


**GitHub publication rehearsal:** gh 2.97.0 exercised the exact six-asset draft and publish flags in
a private rehearsal repository on 2026-08-22. The prerelease stayed
prerelease/not-Latest before and after publication; the stable-shaped release stayed non-prerelease,
became Latest only on publication, and resolved through the latest-release API. Both synthetic
releases and tags were removed. Named evidence:
~/.local/share/omp-session-gateway/test/v0.1.0/stable-release-rehearsal.json.
The same private host then verified failure compensation separately: a complete draft became
non-prerelease Latest, exact release-state validation passed, the release was deleted, the synthetic
tag was deleted, and neither resource remained. The named evidence record includes this row. The
production workflow additionally compares all six GitHub digests with the exact local signed files
and retries API observation on bounded 0/2/4/8-second delays before deleting a failed draft/release.
The private host also passed exact local-to-GitHub digest comparison in both draft and published
states for all six synthetic assets, then removed the release and tag; the same evidence record
contains the digestBinding row.


**Workflow cutover:** historical workflow ID 316404456 at .github/workflows/release.yml reports
state deleted; .github/workflows/signed-release.yml is active on main as workflow ID 339848215.
The candidate tag may use only the active replacement.

### Published beta advertised combinations

| role | exact candidate combination | evidence |
| --- | --- | --- |
| host | Debian 13 (trixie) x86-64, systemd 257, kernel `6.12.94+deb13-amd64` | [gateway run `32530180990`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32530180990): signed artifact, install/readiness, alpha.1 migration/rollback, `107/107` invariants, identity denial, lingering-off/on persistence, uninstall, and teardown. [OMP run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211): exact v17.4.1 source/tree, full checks, Linux binary build, generation-1 View/Control publication, no-store launches, immediate revocation, OMP cleanup, and complete droplet/tailnet/key teardown. |
| host | macOS 26.6.1 arm64 (`Mac14,3`) | candidate checksums/attestations/Cosign, private install, loopback-only listener, `doctor` 17/17, rotation, distinct-node identity/exposure, control-plane reboot/LaunchAgent return, exact patched-OMP build/publication/revocation, and cleanup. A separate alpha.1 → candidate `.20` → alpha.1 rollback-by-reinstall passed 20/20 isolated invariants without touching the live LaunchAgent; exact alpha/beta patched source builds passed manual symlink/version/config reversal. |
| client | Chrome `151.0.7922.171` on Android 17, Pixel 10 Pro | exact candidate discovery and launch authorization; View connected read-only, Control enabled the composer and accepted send, stale View/Control `409`, lock/resume in 5,190 ms, self-verifying 7/7 capability sweep clean before and after force-stop recovery. Abrupt network recovery and background Web Push are excluded. |

**Candidate provenance.** `v0.1.0-prealpha.20` records source
`cffd6bf697c2d3e4c5a5d235c6e58168f5db2eba`, exact OMP
`9350b7990d26ebf69a604edc82d8558ef04adf30`, patch tree
`a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`, and archive/SBOM/checksum-manifest
SHA-256 values `ba789f7a7f6799a53dab205e26cf6f3ebbaa39c2e26655315c1a809075b09ed2`,
`ab2ee850e8a3daeda6c6d77a9dcc77ab9c48c3c0cd225196943de05a27f9988f`, and
`f30fbc8b3a4c276eccd202fcff3765c8ad4d9575f3439c442bf2f443e3f42671`.
`SHA256SUMS`, all three GitHub attestations, all three Cosign bundles, and the signed tag verified;
a clean exact-tag rebuild reproduced all three files byte-for-byte.

**Final release provenance.** `v0.1.0-beta.1` records source
`678887a67e85b14c14afb008cf100391a56aa933`; archive/SBOM/checksum-manifest SHA-256 values are
`2d77c1b23c37d7ee524faa3afd100bcaddc03010a87192b6e313fbcefa0a63c6`,
`4012cd6c8e09d770469498785c58b3a4c1d86ec9a5b4b4944653f29ab4dbffeb`, and
`4e959b394396fea2a56c40dbb9ae8722e2d28ce6c8c4548328712b7620324fa3`. The signed tag resolves
to that source commit; release [run `32539462210`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32539462210)
passed; `gh release verify`, `SHA256SUMS`, all three exact-tag GitHub attestations, and all three
exact-workflow Cosign bundles verified. Published `release-info.json` names the exact source,
v17.4.1 upstream commit, lock digest, and qualified-beta/not-stable boundary.

Candidate and final archives contain the same 48 files. **45 are byte-identical**, including every
runtime executable, gateway module, PWA/collab asset, protocol, dependency lock, license, OMP patch,
and integration metadata file. The only differences are expected and reviewed:
`release-info.json` changes source/timestamp/channel qualification; `SBOM.spdx.json` changes only
source-bound namespace/timestamp/sourceInfo; and `patches/oh-my-pi/README.md` carries the
fresh-host native-addon/Git-identity instructions, exact Linux evidence, and manual rollback prose
that candidate qualification itself proved.

The first post-tag hosted main run exposed a test-fixture race, not a release-byte failure: a
snapshot could hide the banner immediately before replacement EventSource installation, making a
disconnect injection a no-op. The exact scenario passed 10/10 after stream synchronization, the
complete browser suite passed 22/22, private JIT appliance run
[`32540339219`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32540339219) passed,
and post-fix main run [`32540626681`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32540626681)
is green. The fix changes tests only and does not alter the immutable beta artifact.

**Required OMP route.** Stock OMP is insufficient. On both advertised host architectures, the exact
v17.4.1 mbox applied to a pristine checkout, reproduced the pinned tree, passed source checks, and
built `omp-gateway-patched` using OMP's exact official native addon. The macOS build (SHA-256
`310ffd097c87752cbdf78d483e258c09a8450e123eed4e9df05fe9858a7de6b7`) and Linux build (SHA-256
`193b2b8088e78cf61d9bbf28661f3a8c971463cb008fc8d37e1d27eee63c95d3`) each reported
`omp/17.4.1`, auto-published generation-1 View/Control, returned no-store launches, and revoked on
process close. Upstreaming and paired packaging are not beta gates; using the versioned patched
executable is.

**Relay evidence.** The candidate completed a fresh 300-second default-relay smoke with two room
transitions, `finalPhase: "live"`, and exit 0. The protected 28,800-second result transfers because
the relay host/client implementation, collab-web, and wire bytes are identical in the exact alpha
and beta patched trees. The v17.4.1 session-close ordering change is outside the sustained path.

**Accepted limitations, not hidden passes.** The Pixel again reproduced issue #65: after Airplane
mode the device regained tailnet reachability at 29,109 ms while Chrome failed to recover through
the 521-second window, and the subsequent Doze leg also remained wedged. Force-stopping/restarting
Chrome restored a clean capability sweep. Network-change/reconnect therefore remains explicitly
unproven. Background Web Push is implemented but not beta-qualified. Windows, Portal Tunnel,
self-hosted/proxied relays, userspace-networking Tailscale, and every unnamed platform/browser
remain unadvertised.

Named local evidence:
`~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.20/qualification/beta-candidate.json`.
Every candidate resource was cleaned: both Debian droplet/tailnet-node/SSH-key sets were deleted;
the macOS gateway, Serve mapping, patched OMP process/binary/source, and listener were removed; the
isolated rollback root was deleted without changing the live LaunchAgent; and Pixel radio/battery/
Doze state was restored.

## Published alpha baseline

**Alpha.1 decision:** **GO, completed**, for the historical combinations and evidence immediately
below. This section remains the immutable record for `v0.1.0-alpha.1`; it is not the beta claim.

**Advertised host platforms**

| host | exact-candidate evidence | candidate |
| --- | --- | --- |
| Debian 13 (trixie) x86-64, systemd 257, kernel `6.12.94+deb13-amd64` | [run `32502584598`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32502584598): full default lane order, `107/107` rollback invariants, reboot persistence with and without lingering, identity denial, and clean uninstall | `v0.1.0-prealpha.19` |
| macOS 26.6.1 arm64 (`Mac14,3`, build `25G76`) | signed artifact install, `doctor` **17/17**, active token rotation, distinct-node identity/exposure checks, Scaleway control-plane reboot with token continuity, auto-login/LaunchAgent return, and clean uninstall | `v0.1.0-prealpha.19` |

**Advertised client:** Chrome `151.0.7922.171` on Android 17 (Pixel 10 Pro, build
`CP2A.260805.005`, SDK 37), exercised through the macOS candidate host.

**The replacement candidate is bound to exact bytes.** `v0.1.0-prealpha.19` records source commit
`e1b91763b4f0a0e963fc1394d8984ec13ed08d6b`, upstream
`858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`, build
`0.1.0-28d89a99565d`, and archive SHA-256
`f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`. From a clean directory,
`SHA256SUMS` verified, all three GitHub attestations verified against the exact tag/workflow, and all
three Cosign bundles returned `Verified OK`.

**The final release is independently verified and executable-byte-equivalent to the candidate.**
`v0.1.0-alpha.1` records source `5323303cdc3156854f7ede9267863b0148407357`; its archive, SPDX,
and checksum-manifest digests are respectively
`37f12c21975759bbc10fb2f7288149d3cdc5dc82caddcc0a1645d93be71b7506`,
`5c83c333579fc948857255383e4003535c64c596e129444379c910da77a65f7b`, and
`ce220ca82e4174f23da86e3f710b2fbc5020382adb5e966b506952a23ce28a27`. Checksums, all three
GitHub attestations, and all three Cosign bundles verified against the final tag. Candidate and
final archives contain the same 48 paths; 46 are byte-identical, and the only differences are
`release-info.json` plus `SBOM.spdx.json`, where source commit/timestamp/namespace provenance names
the final tag commit.

The final `release-info.json` still carries the build script's conservative static
`pre-alpha; cross-OS and real Android acceptance not yet completed` qualification string. It
underclaims the independently verified release but does not alter executable bytes or the support
matrix above. Rather than rewrite this immutable release, `scripts/build-release.ts` now derives
that field from the release channel `release.yml` exports for the validated tag shape:
`-alpha[.<n>]` records qualified alpha, `-beta[.<n>]` qualified beta, and `-prealpha.<n>` plus
`provenance-test-v…` stay pre-alpha. A build with no channel defaults to pre-alpha; every unknown
value fails. Byte-exact advertised-tag rebuilds must set the matching `alpha` or `beta` channel.

**Candidate `.18` is retained as failed qualification evidence, not promoted.** It exposed a real
operator-path defect: after several successful explicit version switches, systemd's start-rate
counter refused the next rollback and its repair. Candidate `.19` resets that counter only
immediately before an explicit install/rollback start. The state-faithful regression passed locally,
hosted Linux/Windows checks passed, and the exact `.19` Debian lane then completed W0 through W5,
including the formerly failing W2, before ending with the candidate active and `107/107` invariants
passing.

**Debian candidate result.** The archive and provenance were reverified on the droplet; install
produced loopback-only `127.0.0.1:4317`, private `0600` config/token/unit files, and
`installed/active/ready` status. Token rotation replaced PID `2199` with `2302`; diagnostics
contained neither token nor home path. Upgrade from `v0.1.0-alpha`, requested and recorded rollback,
induced-divergence repair, identity denial, two reboot/login persistence passes, active
`uninstall --no-stop` refusal, uninstall, tailnet-node deletion, and droplet teardown all passed.

**macOS candidate result.** The leased M2 host independently verified checksums, GitHub attestations,
and the Cosign bundle, then installed the candidate with private files, a loopback-only listener, and
`doctor` 17/17. Serve returned metadata-only `200 no-store` to the allowlisted identity while direct
tailnet-IP and public-IP backend probes were refused. Token rotation restarted the daemon; the
diagnostics bundle contained neither token nor login. A control-plane reboot changed the measured
boot time, and automatic console login returned the LaunchAgent listening only on
`127.0.0.1:4317` with `installed/active/ready` status and no divergence. The publisher token
remained byte-identical without publishing its fingerprint. Uninstall then left no plist, launchd
job, gateway process, or listener.

**Physical Pixel result.** The candidate launch returned `200` with
`cache-control: no-store, max-age=0`; a self-verifying control planted and detected all seven
forbidden sinks, removed its plants, and found the real capability in none of Local Storage, Session
Storage, cookies, Cache Storage, IndexedDB, history/address state, resource timings, or DOM. A real
history traversal recorded `pagehide.persisted=true` then `pageshow.persisted=true`, restoring `/`
with one directory and no collaboration shell. Against a patched OMP `v17.3.8` process, View exposed
a disabled composer, explicit Control enabled a fresh prompt, the remote turn became interruptible,
Stop settled it, and Sessions returned to a capability-free directory.

**Windows remains unadvertised.** The exact source tree passed hosted current-user service lifecycle,
ACL, IPC, and clean-uninstall checks in [run `32501662399`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32501662399).
Persistent source acceptance on 2026-08-21 subsequently passed install, reboot, first-interactive-
login startup, `doctor` 17/17, rotation, upgrade/rollback, patched OMP publication, and uninstall;
Windows stays unadvertised pending the exact signed gateway/OMP rerun.

**Endurance evidence is reused by code identity, not silently inherited.** Neither the pinned
collaboration client nor the six-commit OMP patch changed in this point release. Candidate `.19`
adds a bounded real Pixel View/Control/prompt/interrupt smoke against those same bytes. The
previous 27,600-second current-pin rerun remains recorded as externally contaminated evidence, and
a protected replacement completed the full authored 28,800-second window on 2026-08-21 with 22
relay-room transitions, `finalPhase: "live"`, exit code 0, and no process restart. Its named record
is `~/.local/share/omp-session-gateway/test/v0.1.0-alpha.1/soak/protected-relay-soak-8h.json`.

**Required deployment preconditions.** Tailscale Serve over tailnet HTTPS is the only supported
remote path; Funnel must stay disabled; and Tailscale must run its **TUN-mode** client.
Userspace-networking `tailscaled` does not establish the listener/identity trust boundary and the
gateway fails closed in that topology ([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)).

**Known limitations.** Recovery after an abrupt radio transition on Android may require
force-stopping Chrome: Chrome-for-Android can wedge its network stack while the device remains
healthy, so network-change and reconnect remain explicitly **unproven**
([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)). Preview notification detail
currently falls back to Session detail because the OMP publisher carries no bounded preview field.
Windows is not advertised: #90 and reboot/login behavior now pass in source, but its exact signed
Windows artifact lane remains open; that narrower support gap does not block beta. Self-hosted or
proxied relay modes remain unsupported.

Anything outside the table above is unqualified and must not be presented as a working deployment
path. Passing one platform permits advertising only that exact platform/version combination.

**Pin (historical alpha baseline).** OMP `v17.3.8` /
`858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`, refreshed 2026-08-19 and revalidated for alpha.1.

This ledger is the source of truth for the current release decision and its implementation evidence.
Compatibility claims live in [`COMPATIBILITY.md`](COMPATIBILITY.md); required scenarios are
defined in [`TEST_PLAN.md`](TEST_PLAN.md).


## Status rules

| Status | Meaning |
|---|---|
| **PASS** | The named scope has current, reproducible evidence. It says nothing about a broader scope. |
| **PARTIAL** | Some automated or smoke evidence exists, but the complete release scenario has not passed. |
| **NOT RUN** | No completed result is recorded for the required environment or scenario. |
| **BLOCKED** | A known prerequisite prevents completion or publication. |
| **N/A** | Deliberately excluded from this release and not advertised. |

An advertised alpha, beta, or stable release requires every applicable release-blocking row below to be **PASS**.
Automated tests, mocks, a desktop mobile viewport, or generated service definitions do not
substitute for native OS, real Tailscale, real relay, or Android qualification.

## Recorded implementation evidence

The table retains historical evidence across pre-alpha, alpha, and beta qualification. The stable
decision and its exact candidate evidence are the bounded record at the top of this document.

| Scope | Status | Recorded evidence |
|---|---|---|
| Exact upstream pin | **PASS** | `UPSTREAM.lock.json` pins `can1357/oh-my-pi@858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`, tag `v17.3.8`, with package and Bun versions. The regenerated five-commit mbox applies cleanly to the pristine pin and reproduces tree `1320e3e7e7596dbe2f6a130d568072a9a38f2943`. Its first four commits are the reviewed handoff artifact `gateway-collaboration-v17.3.8.mbox` (sha256 `f63f74c90d72776ca1ebcb4b1a75b18130b3c65d1c6e0133c9bbb3a8e5b4af49`) applied verbatim with plain `git am`; the fifth restores the health-probe commit that the maintained series no longer carries. Recorded 2026-08-19. |
| Repository check | **PASS** | Re-run at the `v17.3.8` pin on 2026-08-19, at doctor pin-contract commit `bb0a852b0c4c72181718033f261e0ff2901a08c8`. `bun run check` passed handoff validation, four workspace typechecks, production web/client builds, 133 tests with 767 assertions across 22 files, and capability-leak scanning. Twenty Android-sized Playwright cases passed at both `412 × 915` and `390 × 844`: installed-PWA View/Control handoff, the embedded active-ask 3d shell, direct client navigation returning to the directory, answer-feedback dismissal by keyboard/tap-out/swipe/timeout, transport-interruption reconnect, stale-session failure states, metadata-only attention and background-alert settings, and automatic plus collaboration-preserving PWA activation. |
| Host-suspension recovery experiment | **PASS** | The downloaded and independently verified `provenance-test-v0.1.0.10` gateway plus the exact patched OMP publisher were suspended beyond a five-second test TTL, then resumed gateway-first, publisher-first, and together. Every order first lost the expired card, mutually re-authenticated, sent a full upsert, and restored one session within eight seconds. This finite missed-timer reproduction does not replace actual macOS sleep/wake qualification. |
| Dependency audit | **PASS** | `bun audit` reported no vulnerabilities for the recorded lockfile. |
| OMP patch application and lifecycle fixtures | **PASS** | Re-run at `v17.3.8` on 2026-08-19: `git apply --check` passed against the pristine pin, and the documented suite passed 108 tests with 506 assertions across nine files plus five slash-command tests with 29 assertions. `bunx tsc --noEmit -p packages/coding-agent/tsconfig.json` produced 66 errors on the patched tree and the identical 66 on pristine `v17.3.8`, with none unique to the patch; those are upstream-baseline errors in advisor, eval, markit, stt, tts, and vibe files, several from optional dependencies such as `mupdf` that are absent in a fresh checkout. |
| Registry mutual authentication | **PASS** | Shared gateway and standalone OMP proof-vector tests agree; stale client proof replay is rejected; a fake server receives only `hello`; and an isolated real gateway/synthetic-publisher smoke published metadata then revoked it on disconnect without key/capability log output. |
| Full pinned OMP checkout | **PASS** | `bun run ci:check:full` passed. Every official TypeScript test outside five independently reproduced pristine-baseline failures passed in its official bucket. The unchanged baseline failures are two Python completion-runtime assertions, two status-path assertions, and one session-file timestamp-ordering assertion; no patch-specific failure remained. |
| Deterministic runtime archive | **PASS** | Two clean local builds from hardening commit `99e34ee866d30dbb6424346404dc293727daa319` produced byte-identical 848,896-byte archives, SPDX 2.3 inventories, and checksum manifests. `SHA256SUMS` verified archive digest `7c25c37dd25bf2e93f7b8c48d1f0214c51f46709d82fcb830f7a0b7aae80e472` and SPDX digest `730097f950f9f2f4684b0358907870b889f32b690f7a6bbfe0d544be50b686fd`; `release-info.json` pins that source commit, upstream `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, and the exact lock digest. This is unsigned local preflight, not signed-candidate qualification. |
| Extracted archive command smoke | **PASS** | The hardening archive's bundled CLI completed `--help`, isolated `install --no-start`, inactive `status`, Serve guidance, redacted `doctor --bundle`, and `uninstall --no-stop` on macOS arm64 without touching the live trial. The generated publisher token was 43 bytes with mode `0600`, its config directory was `0700`, and its bytes appeared in no other smoke file or diagnostic; the synthetic login, tailnet host, and full smoke path were also absent from diagnostics. A fresh archive from commit `a514c9ca8ab9611dd934c09b5ddc8dd2074c2ac7` then ran its bundled gateway on an isolated loopback port, mutually authenticated three source-checkout publishers, returned metadata-only revision 3, served a no-store in-memory launch response, rejected a stale generation with `409` and no capability field, and removed all records on publisher socket close at revision 6. Re-run at the `v17.3.8` pin on 2026-08-19 from a freshly built archive at merge commit `ac63641`, in a hermetic root under `env -i`. `--help`, `install --no-start`, `status`, `serve-guidance`, `rotate-publisher-token`, `doctor --bundle`, and `uninstall --no-stop` all behaved correctly; the publisher token was 44 bytes at `0600` with `0700` config and state directories, and the diagnostics bundle contained no token, allowlisted login, tailnet host, or install path. This run doubles as the regression proof for the service-ownership fix: the same sequence on 2026-08-19 had reported `active: true` from the production service and `rotate-publisher-token` booted out the live daemon, whereas it now reports `active: false`, rotation exits 0 on the inactive branch, and the live daemon's PID, launchd registration, LaunchAgent file, and sixteen `doctor` checks were all unchanged across the run. |
| Desktop mobile-viewport browser smoke | **PASS** | Chromium at `412 × 915` rendered three synthetic sessions; SSE, generation conflict, no-store launch, URL scrub, storage/cache checks, and prompt socket-close removal passed. A separate `390 × 844` run proved overlapping snapshot/SSE revision ordering, stale-metadata clearing on transport loss, and query-bearing asset cache bypass. The extracted `a514c9c` runtime repeated the `412 × 915` path: its client popup used `/client/` with no query, fragment, referrer, cookie, history state, Local/Session Storage, IndexedDB, or secret-bearing resource URL; Cache Storage contained only the two immutable app assets, recovery returned to `/`, and SSE exposed the empty state immediately after socket-close removal. Re-run at the `v17.3.8` pin with the re-vendored client on 2026-08-19: all twenty Playwright cases passed at both `412 × 915` and `390 × 844`. |
| Desktop background Web Push browser smoke | **PASS** | Chromium at `412 × 915` explicitly granted permission and created a real HTTPS Push subscription. With the PWA document navigated away, the gateway delivered encrypted Web Push and the service worker displayed fixed title `OMP session needs attention`, an empty body, and metadata-only instance/generation data. A stale notification route was synchronously scrubbed to `/` and retained the visible expired state. This does not prove Android OS delivery, force-stop behavior, lock-screen presentation, or tap-to-Control. |
| Isolated attention lifecycle smoke | **PASS** | A real gateway and mutually authenticated publisher drove same-generation false-to-true-to-false state through IPC, registry, SSE, and the built dashboard. Chromium observed the accessible attention state, authoritative clear, and removal; no synthetic capability marker appeared in DOM, URL/history, Local/Session Storage, cookies, gateway logs, or cached shell state. This does not replace a patched real-OMP retained-request/Control smoke or physical Android qualification. |
| macOS/Tailscale development-checkout qualification | **PASS** | macOS 26.5.2 arm64 completed live LaunchAgent install/reinstall, permissions, token rotation, diagnostics bundle, Serve access as the allowlisted node identity, loopback-backend identity rejection, loopback/LAN isolation, and uninstall. Distinct-device allowlist isolation remains a separate gate below. |
| Linux container lifecycle qualification | **PASS** | Debian 13 arm64 with a real systemd user manager completed the development-checkout lifecycle and repeated it from unsigned extracted archive commit `f821335e1ae7fc5c98bf57370019bdc9176b5c2e`. The artifact installed and became ready, kept config/token/service files at `0600` and private directories at `0700`, accepted only loopback traffic, replaced PID 234 with 415 on active reinstall, rotated the token and replaced PID 415 with 497, produced diagnostics excluding the token, login, host, and home path, refused `uninstall --no-stop` while active, then removed the service, process, and listener on normal uninstall. This is explicitly container preflight, not bare-metal or signed-candidate qualification. Re-run at the `v17.3.8` pin on 2026-08-20 on Debian 13.6 aarch64 with `systemctl --user` reporting `running`, from an extracted archive built at merge commit `ac63641` on Bun 1.3.14. Install reached ready with MainPID 159; the unit file, `config.json`, and the 44-byte publisher token were `0600` with `0700` config and state directories; `ss` showed a single listener bound to `127.0.0.1:4317`; active reinstall replaced PID 159 with 239; token rotation changed the token digest and replaced PID 239 with 292; the diagnostics bundle contained no token, allowlisted login, tailnet host, or home path; `uninstall --no-stop` refused with exit 1 while the service stayed active; and normal uninstall removed the unit, left `is-active` inactive, left zero listeners on 4317, and reported `installed:false`. |
| Windows hosted source-checkout qualification | **PASS** | [GitHub Actions run 29791906104](https://github.com/alphastorm/omp-session-gateway/actions/runs/29791906104) applied the exact candidate OMP patch, passed all eleven publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, post-restart token reread, and an explicit token path preserving ambient XDG configuration—and the coding-agent typecheck, then completed gateway IPC/config/token ACL tests, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, health/status, token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall. |
| Real desktop OMP/browser acceptance | **PASS** | Three patched interactive OMP processes auto-published without `/collab`; Chrome 150 at `412 × 915` observed cards, View/Control separation, prompt, interrupt, process removal, safe leave, no URL/storage capability, and foreground/online transport replacement. A live `/new` revoked generation 1, published generation 2 after replacement, and left generation 1 unlaunchable (`409`). A later metadata-refresh smoke published the initial `provider/model`, updated title and CWD plus two model events on the same instance/generation across directory revisions 14–18, and revoked at revision 19. |
| Default-relay endurance soak | **PASS** | The signed `v0.1.0-prealpha.2` recovery rerun completed 28,800 seconds with eight relay-room transitions, `finalPhase: "live"`, exit code 0, and no process restart. Gateway RSS moved from 45,776 KiB to 46,496 KiB (+720 KiB, approximately 1.6%). The named record is `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.2/soak/recovery-v012-relay-soak-8h.json`. A re-run at the `v17.3.8` pin on 2026-08-20 sustained **27,600 seconds**, 96% of the 28,800-second window, before terminating on `relay ended during soak: timed out waiting for the host's welcome`. The cause was external and documented: three Android acceptance runs were pointed at the soak's own host session, and each fires real view, control, and stale-generation launches into that session's relay room, so the collaboration host faulted. The relay connection itself did not fail. An earlier attempt the same day ended at 2h48m when its host session, started before the [#61](https://github.com/alphastorm/omp-session-gateway/issues/61) fix was activated, hit the publisher latch. Both terminations are attributable to the host side rather than the relay. A protected replacement then completed **28,800 of 28,800 seconds** from `2026-08-21T09:44:45.171Z` to `17:44:45.344Z`, made 22 relay-room transitions, remained in `finalPhase: "live"`, and exited 0 with no process restart. The harness records no memory metrics, so no RSS delta is claimed. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-alpha.1/soak/protected-relay-soak-8h.json`. |
| Physical Android `v0.1.0-prealpha.4` trial | **PARTIAL** | Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` passed installed-PWA View/Control/Back, exactly-once retained response, attention clearing, metadata-only foreground and lock-screen notification, dashboard-only notification tap, lock/resume, Wi-Fi/cellular transition, automatic relay reconnect, generation replacement with stale `409`, and TTL removal/republication. Distinct-identity denial, deep physical-browser sink inspection, interrupt, and remaining switch/branch/resume cases were deferred. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.4/qualification/local-android-launch-fix.json`. |
| Physical Android and capacity `v0.1.0-prealpha.5` trial | **PASS** | The downloaded archive passed checksum, GitHub attestation, Cosign bundle, signed-tag, and exact-byte reproduction verification. On the same Pixel/Android/Chrome combination, three real patched OMP sessions appeared automatically; Airplane mode cleared all cards by the 40-second observation after the configured 35-second SSE deadline, and restoration returned exactly three without Refresh or duplicates. A separate signed-runtime run held 50 publishers for a 642-second measured window at the normal heartbeat cadence, averaging 0.125% of one CPU core with maximum observed daemon RSS 63,760 KiB; all 50 remained fresh and clean shutdown removed all 50. Twenty local launch calls measured 0.496 ms p95. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.5/qualification/android-offline-and-capacity.json`. |
| Physical Android background Push `v0.1.0-prealpha.7` trial | **PARTIAL** | After the signed candidate was installed behind the canonical Tailscale Serve origin, the user reported the instructed phone flow working: explicit background-alert enablement, notification delivery with the PWA closed, and notification-tap entry into current Control. This is direct user confirmation of the core experience, not a complete qualification record: fresh device/OS/browser versions, lock-screen presentation, force-stop behavior, stale-generation handling, network transitions, forbidden-sink inspection, and a named evidence artifact were not captured in this trial. |
| Private vulnerability reporting | **PASS** | GitHub repository private vulnerability reporting returned `enabled: true` on 2026-07-20. |
| Deterministic SPDX inventory | **PASS** | Two release builds produced identical archive and SPDX 2.3 digests; `SHA256SUMS` verified both and the archive contains `SBOM.spdx.json`. |
| Hosted signing and provenance | **PASS** | Corrected [`provenance-test-v0.1.0.10`](https://github.com/alphastorm/omp-session-gateway/releases/tag/provenance-test-v0.1.0.10) at protected-main merge commit `1c33c90252643d7d0f572fe57a0e560f00b72afb` ([run `29792234310`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29792234310)) published six immutable-release-attested assets. Downloaded checksums, all three GitHub build attestations, all three Cosign bundles, and release provenance verified independently. A clean exact-tag rebuild was byte-identical for the archive (`b446d405d97c2bec181b9d0f4be03c83ede7407d24d603a9d117be428b95576e`), SPDX inventory (`4cb0b1b2c81fdcaf56044cd38259a9ad979bff88efd75ca9a7a2fe3f30d6e8f1`), and checksum manifest (`08d28faa291f7b374dc8d6d88656c5e7e84cda93f65707acdc6a530415b39326`). |
| Signed candidate packaging/runtime smoke | **PASS** | The downloaded and independently verified `provenance-test-v0.1.0.10` archive installed with `--no-start` into an isolated macOS root, launched the installed runtime through the existing real Tailscale Serve mapping, and mutually authenticated three reconnect-capable patched OMP publisher fixtures. A real gateway restart restored all three cards in approximately 227 ms; a patched interactive OMP process auto-published a fourth card and revoked it immediately on shutdown. The controlled suspension experiment used this installed gateway and restored each expired session within eight seconds in all three resume orders. This is packaging/runtime and finite-suspension evidence, not complete LaunchAgent, distinct-device identity, actual sleep/wake, real collaboration, or Android qualification. |
| Repository security controls | **PASS** | Private vulnerability reporting, dependency alerts and automated security updates, secret scanning and push protection, and immutable releases are enabled. `main` requires signed commits, pull requests, current implementation/Windows checks, resolved conversations, and blocks force-pushes and deletion. |
| Production registry-socket rebind | **PASS** | On 2026-08-19 the installed macOS daemon (PID 9994, started 2026-08-16 23:13) was observed listening on a `registry.sock` whose inode was created 2026-08-17 09:31 — about ten hours after process start — so the watchdog re-bound the rendezvous point after macOS reaped the per-user `TMPDIR` entry, with no operator action and no daemon restart. `doctor` returned all sixteen checks true and four `omp-code-mode` publishers were connected to the re-bound socket. This is unsolicited production evidence for the fix merged in PR #47; it does not advance the macOS host lifecycle gate below. |
| Live `doctor` at the refreshed pin | **PASS** | On 2026-08-19, after the `v17.3.8` refresh, `doctor` run from the updated checkout against the installed macOS daemon returned all sixteen checks true, including `compatibility`, `serveMapping`, `identityAllowed`, `funnelDisabled`, `listenerLoopbackOnly`, and `publisherHealth`. The first attempt returned `compatibility: false` because `doctor` hardcodes the expected upstream identity and the refresh had left it naming `v17.0.6`; that is fixed and now bound to `UPSTREAM.lock.json` by a pin-contract test. Four `omp-code-mode` publishers from the previous `17.3.5` release were connected throughout, so this is not evidence that a `17.3.8` OMP process publishes. |
| Cross-platform source portability | **PASS** | `portable-source` in `compatibility.yml` passed on `ubuntu-24.04`, `macos-latest`, and `windows-latest` in `main` runs [36015874710](https://github.com/alphastorm/omp-session-gateway/actions/runs/36015874710), [36016932843](https://github.com/alphastorm/omp-session-gateway/actions/runs/36016932843), and [36018136930](https://github.com/alphastorm/omp-session-gateway/actions/runs/36018136930). Linux and macOS ran all 52 test files and Windows 47; `scripts/test-portable.ts` names the five host-bound exclusions. Recorded 2026-09-24. Hosted runners, so this is tested evidence (ADR-030), not host qualification. |
| Browser-engine compatibility | **PASS** | `browser-core` ran the 12 `@core` e2e tests on desktop Chromium, Firefox, and WebKit and on iPhone-class WebKit emulation: 47 cases passed in 1.2 minutes on #249 and again in `main` runs [36016932843](https://github.com/alphastorm/omp-session-gateway/actions/runs/36016932843) and [36018136930](https://github.com/alphastorm/omp-session-gateway/actions/runs/36018136930). Desktop WebKit runs without service workers because Playwright's WebKit has no push service. Recorded 2026-09-24. Engines and emulation, not physical-device qualification. |
| Stock OMP on a Windows host | **PASS** | `canary-windows` passed publish, snapshot, stale-generation refusal, View and Control relay joins with prompt echo, and unregister against stock OMP 18.3.0 in discovery runs [36012005712](https://github.com/alphastorm/omp-session-gateway/actions/runs/36012005712) and [36014286823](https://github.com/alphastorm/omp-session-gateway/actions/runs/36014286823), #250 runs [36016871476](https://github.com/alphastorm/omp-session-gateway/actions/runs/36016871476) and [36017490514](https://github.com/alphastorm/omp-session-gateway/actions/runs/36017490514), and `main` dispatch [36018460475](https://github.com/alphastorm/omp-session-gateway/actions/runs/36018460475). The published v0.5.3 archive installed with the documented PowerShell steps in run [36018098085](https://github.com/alphastorm/omp-session-gateway/actions/runs/36018098085). Recorded 2026-09-24. Hosted runner, not Windows release qualification ([delta](WINDOWS_QUALIFICATION.md)). |

The evidence date and caveats above come from the implementation handoff and the current
provenance-test artifact. Every later candidate must rerun the applicable clean-checkout CI and
native qualification and attach those records to its tag.

## Alpha gate ledger

| Release gate | Status | Evidence or missing proof | Required to close |
|---|---|---|---|
| Exact OMP and collab-web provenance | **PASS** | Immutable source commit, package versions, relevant paths, local integration, and patch are recorded in `UPSTREAM.lock.json` and `packages/collab-client/upstream/UPSTREAM.json`. **Pin classification 2026-08-21:** this row is repository state, not a candidate-tag revalidation. `UPSTREAM.lock.json` itself records `observedAt` 2026-08-19 at `v17.3.8`/`858f7dd9`, so the pin metadata is current, but the ledger sentence carried no observation date of its own. Treat provenance as current only for the files and patch as they stand at the recorded pin; re-inspect them at each new candidate tag rather than assuming this row travels forward. | Revalidate unchanged data at the candidate tag. |
| Repository automated suite | **PASS** | Candidate `.19` release gates passed handoff validation, every workspace typecheck, production web/client build, 382 Bun tests with 1,955 assertions across 30 files, capability/identifier leak scans, and 22 Playwright cases across both Android viewports. Required PR checks also passed the hosted Windows lifecycle and native Linux arm64 source checkout. | Keep required checks green on the final tag commit. |
| OMP patch compatibility | **PASS** | Patch apply-check, 114 focused attention/lifecycle fixtures, the coding-agent package typecheck, and `bun run ci:check:full` passed against the exact pin. Every non-baseline official TypeScript test passed; five failures reproduce unchanged on the pristine pin. | Rerun from the exact pin at the candidate tag; do not broaden the OMP range. |
| Fifty-publisher capacity | **PASS** | The signed `v0.1.0-prealpha.5` daemon held 50 authenticated publishers and sessions for a 642-second measured window at the normal 10-second heartbeat cadence. It consumed 0.80 CPU seconds over that interval (0.125% of one core average), stayed below 63,760 KiB observed RSS, retained 50 fresh records, logged no warnings/errors, and removed all 50 on clean publisher shutdown. The capacity files contained no synthetic capability marker. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`** using the in-repository `synthetic-publisher.ts` against an isolated daemon on port 4319 with its own config, state and runtime roots, so the founder's live daemon on 4317 was never involved. 50 publishers completed the real mutual-HMAC handshake over the Unix-domain socket and were held for a 606-second window at the 10-second heartbeat across 41 samples. Session count was **50 at every one of the 41 samples**, minimum equal to maximum, so no record expired while its publisher was heartbeating. The daemon consumed **0.85 CPU seconds over 606 s (0.140% of one core)** with **peak RSS 68,832 KiB and mean 54,078 KiB**. Both figures are modestly higher than the `v0.1.0-prealpha.5` baseline of 0.80 CPU seconds at 0.125% and under 63,760 KiB; recorded as measured rather than smoothed. The metadata response contained no capability-bearing field. | Repeat on every later candidate and investigate any material regression from this baseline. |
| Capability non-persistence | **PASS** | On candidate `.19`, Pixel Chrome `151.0.7922.171` ran the self-verifying `android-leak-sweep.ts`: all seven control sinks detected the planted secret and were cleaned, the real launch was `200 no-store`, and the capability was absent from browser storage, cookies, caches, IndexedDB, URL/history, resource timings, and DOM. | Repeat on every advertised client candidate. |
| Loopback-only exposure | **PASS** | Candidate `.19` listened only on `127.0.0.1:4317` on Debian and macOS. Distinct-node probes to the macOS tailnet and public addresses were refused; Debian public/tailnet backend probes were refused and uninstall removed the listener. | Repeat on every advertised host candidate. |
| Tailscale Serve identity and application allowlist | **PASS** | macOS Serve returned metadata-only `200 no-store` for the real allowlisted identity and ignored a forged header; direct backend addresses were refused. The tagged Debian node carried no user login and was denied, while local requests without identity returned `403`. Funnel was disabled and both hosts had a real TUN interface. | Repeat allowed and denied halves for later candidates. |
| Linux host lifecycle | **PASS** | Candidate `.19` passed [run `32502584598`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32502584598): signed artifact verification, private permissions, install/readiness, rotation, migration from `v0.1.0-alpha`, requested and recorded rollback, `107/107` rollback invariants, identity denial, reboot persistence with lingering off/on, active-uninstall refusal, uninstall, and paid-resource teardown. | Re-run for each advertised Linux candidate. |
| macOS host lifecycle | **PASS** | Candidate `.19` on macOS 26.6.1 arm64 (`Mac14,3`) passed artifact verification, install, `doctor` 17/17, rotation, identity/exposure, control-plane reboot with `kern.boottime` change and unchanged token, automatic LaunchAgent return at console login, loopback-only readiness, active-uninstall refusal, uninstall, and process/listener cleanup. | Re-run for each advertised macOS candidate; the claim is interactive-login startup. |
| Windows host lifecycle | **PARTIAL** | Hosted run `29791906104` passed current-user pipe derivation, strict token ACLs, publisher mutual authentication, cross-user denial, service lifecycle, rotation, and uninstall. Persistent Windows Server 2025 source acceptance on 2026-08-21 then exercised the real boundary: exact source `622c242c625f3ab23b11b55f5a6994953895ba23` installed in 77,498 ms on 2 vCPU/4 GiB; a real reboot left the task installed but inactive with no listener before login; a certificate-pinned RDP login fired `LogonTrigger` without `/Run` and restored readiness; config/token hashes survived. Rotation, active upgrade, history-selected rollback, TUN-mode Serve, `doctor` 17/17, and uninstall passed. Exact OMP `v17.4.1` plus patch SHA-256 `abcc8866f76fc82485a42c0ce51ca19aec3b928afcddf0af1c25c35dd10ad4e2` produced an unsigned Windows binary that auto-published View/Control, returned `200 no-store` launches, denied a stale generation `409`, and revoked within 374 ms after forced exit. The source lane is accepted; release status stays PARTIAL because both gateway and OMP inputs were unsigned and the complete Windows `read-only.test.ts` fixture exposed a hang after six passing cases. See `docs/WINDOWS_QUALIFICATION.md`. | Repeat the whole sequence with the exact signed gateway candidate and paired signed OMP distribution; resolve or explicitly baseline the bounded fixture hang. Advertise only “starts at interactive login,” never unattended boot. |
| Android PWA installation | **PARTIAL** | Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` installed the PWA from tailnet HTTPS, activated corrected `v0.1.0-prealpha.4` and signed `v0.1.0-prealpha.5` shells, and loaded the metadata directory. The loaded v0.1.0-prealpha.5 shell cleared all cards after a silent Airplane-mode partition and restored only a fresh snapshot; cold offline navigation remained unavailable as designed because navigation bypasses the service worker. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`** on the physical Pixel 10 Pro with Chrome `151.0.7922.139`: the shell loaded over tailnet HTTPS with the service worker **active** at the origin root scope, the manifest resolving to name **OMP Sessions**, `display: standalone`, four icons and `start_url: /`. Cache storage held exactly one entry, the immutable application shell `omp-sessions-shell-c08260c80b66`, and `location.hash` was **0 characters**, so no capability reached the address bar. The metadata directory answered `200` in 51 ms at revision 42. | Complete the deferred deep physical-browser sink inspection before advertising this client combination. |
| Three real OMP processes auto-discover | **PASS** | Three patched interactive OMP processes in `workspace`, `workspace-2`, and `workspace-3` appeared automatically without Refresh on the physical Pixel through the signed `v0.1.0-prealpha.5` gateway. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`**: three patched interactive OMP processes launched in `qual-three-a`, `qual-three-b` and `qual-three-c` all appeared automatically in the live directory at revision 30 without Refresh, each at generation 1 with `canView` and `canControl` true. This re-establishes the host half at the current candidate; the physical-device half of this row still rests on the earlier `v0.1.0-prealpha.5` observation. | Repeat on every later candidate/device combination. |
| Real View and Control behavior | **PASS** | On candidate `.19` and the physical Pixel, a patched OMP `v17.3.8` session auto-published with View and Control. View rendered a disabled composer; explicit Control enabled a fresh prompt; the remote turn became interruptible; Stop settled it; and Sessions returned to a capability-free directory. The separate launch/leak sweep returned `200 no-store`. | Repeat the real interaction smoke on later client/candidate combinations. |
| Real lifecycle revocation | **PARTIAL** | Physical Android observed automatic single-card generation 2→3 replacement without Refresh; old generations 1 and 2 each returned `409`. Suspending the live OMP publisher expired the card at revision 19 and resuming restored generation 3 at revision 20 without Refresh, duplication, or stale launch. Re-measured on 2026-08-19 at the `v17.3.8` pin against the upgraded live gateway `0.1.0-61114587f124`, using a scratch OMP session so live sessions were untouched. **Switch** (`/new`): generation 1 returned `200` through t=10 s, `404` at t=12 s, and `409` from t=13 s, which is when generation 2 first became visible — the stale generation was unreachable before the replacement was published, with no overlap. **Crash** (`SIGKILL`): removed in ~1 s by socket close, launch `404`. **TTL sweeper** (`SIGSTOP`, socket held open, heartbeats stopped): still listed and launchable at t=30 s, absent at t=38 s, so expiry landed at ~34 s against the configured 35 s budget; `SIGCONT` republished the same instance at revision 24. A nonexistent generation returned `409 generation_mismatch`, and repeated launches returned `429`. Branch and saved-session resume were measured on 2026-08-20 with a session carrying real conversation history, recorded in [`LIFECYCLE_BRANCH_RESUME.md`](LIFECYCLE_BRANCH_RESUME.md). Branch ordering held: generation 1 read `404` at 15:31:05.027Z and generation 2 first appeared at 15:31:05.847Z, an 833 ms window in which the old generation was already dead and the replacement did not yet exist, so the directory never showed two generations at once and the sequence was `200 -> 404 -> 409`, never `200 -> 200`. Stale **control** at the old generation returned `409 generation_mismatch` while generation 2 was live with `canControl` true. A branch also produces a second revoke/publish pair 35 s later re-advertising the same capability digest, and ordering holds there too. Clean exit removed the card in about 13 s, well inside TTL, and resume republished as a **new** instance at generation 1 about 18 s after process start, with the pre-exit pair returning `404` on all 41 probes including an explicit stale-control probe.| The tree-navigation spelling of `/branch`, which this host's default `doubleEscapeAction=tree` actually routes to, was not exercised, and no browser or Android observation was made. The default-relay half of blocker 4 remains separate. |
| Android lock, resume, network, back, and reconnect | **PARTIAL** | Pixel 10 Pro lock/unlock preserved the authoritative attention state without duplicates; Wi-Fi→cellular→Wi-Fi recovered automatically with Tailscale enabled; View reconnected, and Android Back returned to Sessions. On signed `v0.1.0-prealpha.5`, a silent Airplane-mode partition cleared all cards by the 40-second observation after the configured 35-second deadline despite Tailscale's virtual interface, and restoration fetched exactly three fresh cards without Refresh. On 2026-07-25, the unreleased 5-second SSE / 12-second liveness build was installed on the canonical macOS gateway; `doctor` passed every check and a live Android-sized Chromium offline→online transition restored two cards automatically without Refresh. On 2026-08-20 the matrix was re-run at the `v17.3.8` pin from a development install via `scripts/android-acceptance.ts` on Android 17 `CP2A.260805.005` / Chrome `151.0.7922.139`. Lock and resume recovered in 3,465-3,674 ms after wake with a 64-106 ms fetch and no unreachable banner, across three runs. Forced deep Doze reached `IDLE` and recovered in 8,484-9,348 ms. Airplane mode showed the unreachable banner during the outage in every run and recovered automatically without a reload in 14,873 ms and in 83 ms on two runs — but a third run stalled for 471,257 ms while `adb shell ping` proved the device had reached the host at 28,424 ms, recovering only after the Doze cycle ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)). The Wi-Fi-to-cellular leg could **not** be exercised: with Wi-Fi disabled the device reported `Active default network: none` and `connect: Network is unreachable`, because the Google Fi SIM is present but `NOT_READY`. The earlier Wi-Fi/cellular/Wi-Fi claim in this row therefore cannot currently be reproduced on this hardware and should be treated as unverified until a device with working cellular data is available. Chrome freezes the renderer while the display is off, so lock-state observation is only possible after waking. Re-run on 2026-08-20 against the signed candidate: lock/resume recovered in 3,872 ms and forced deep Doze in 9,335 ms, and the airplane stall reproduced a second time with the device reachable at 28,354 ms versus 28,424 ms on the development install, confirming [#65](https://github.com/alphastorm/omp-session-gateway/issues/65) is not specific to a development build and reproduces when a lock/resume cycle precedes the transition. **Partially re-run 2026-08-21 against `v0.1.0-prealpha.17`** on Chrome `151.0.7922.139`. Lock/resume: after a screen-off, wake and unlock cycle the directory still answered `200` in 41 ms. Recorded honestly, the page reported `visibilityState: hidden` at that instant, so this shows the fetch path surviving the cycle rather than a foregrounded render. Back navigation: launching View is a **real navigation** from `/` to `/client/` that grows history from 2 to 3 entries and carries **no URL fragment**, and both `history.back()` and the in-app `← Sessions` control return to `/`. A hardware Back sent via `adb input keyevent 4` produced no change even with `Page.bringToFront` confirming `visible`, so that key is not reaching the page through this harness; it is a **harness delivery limitation, not a product result**, and physical-gesture Back remains unproven. **Network-change and reconnect remain blocked** by [#65](https://github.com/alphastorm/omp-session-gateway/issues/65). | Characterise and attribute #65, obtain a device with working cellular data to re-prove the Wi-Fi/cellular transition, repeat the exact `alpha`↔`alpha_2g` transition on physical Android, and re-run all of it against a signed candidate artifact. |
| Android attention notification | **PARTIAL** | The earlier foreground-only trial passed fixed metadata-only notification text, lock-screen presentation, dashboard-only tap, and lock/resume. On signed `v0.1.0-prealpha.7`, the user subsequently reported the instructed closed-PWA background notification and tap-to-current-Control flow working. The report confirms the core physical experience but lacks fresh version capture and the remaining background matrix. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`** on the physical Pixel 10 Pro with Chrome `151.0.7922.139`, exercising the full cycle rather than only the appearance. A disposable OMP session was driven into a real pending ask; the directory then reported that session as the only one with `inputRequired` true and `canControl` true, and the PWA rendered its attention affordance, offering **Open request** and **View transcript instead**. The `ask` field is metadata-only: a 90-character object carrying just `requestId` and `since`, with no question text, no capability and no URL, so the attention signal travels without the content. Answering the prompt cleared it at directory revision 51, with no session reporting `inputRequired` and no session carrying an `ask`. | Capture exact current device/OS/browser versions and complete lock-screen, force-stop, stale-generation, network-change, and forbidden-sink checks with a named evidence artifact before broadening the claim. |
| Existing OMP relay connectivity | **PASS** | The unchanged collab client/OMP patch retains the signed 28,800-second PASS, the 27,600-second externally contaminated current-pin rerun, and the protected 28,800-second replacement completed on 2026-08-21 with 22 transitions, `finalPhase: "live"`, exit code 0, and no restart. Candidate `.19` also passed a bounded real Pixel smoke through the default relay: View, Control upgrade, prompt, interrupt, and return. | Re-run endurance only when relay/client/host protocol bytes change; keep a bounded real smoke per candidate. |
| Platform install/doctor/uninstall | **PASS** | Both advertised hosts passed complete signed-candidate `.19` artifact lifecycles. Debian included migration/rollback and reboot/lingering; macOS included control-plane reboot/login persistence. Windows now passes the same source-level lifecycle through reboot→interactive-login, `doctor` 17/17, rotation, upgrade/rollback, patched OMP publication, and uninstall, but remains unadvertised until exact signed gateway and OMP artifacts repeat it. | Requalify exact signed bytes on every advertised host. |
| Configuration migration and rollback | **PASS** | Candidate `.19` upgraded from `v0.1.0-alpha`, preserved configuration/token/modes, exercised requested and history-selected rollback in both directions, repaired induced divergence, and passed all `107/107` rollback invariants. The `.18` start-rate failure is retained as the regression this candidate closes. | Repeat predecessor→candidate migration and rollback for later release lines. |
| Private vulnerability reporting | **PASS** | GitHub private vulnerability reporting is enabled and repository security guidance identifies the private path. This is hosting state and pin-independent; it was rechecked before alpha promotion. | Reverify before publication. |
| Release signing, SBOM, and provenance | **PASS** | `v0.1.0-prealpha.19` published six assets from source `e1b91763…`; archive SHA-256 is `f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`. `SHA256SUMS`, all three GitHub attestations, and all three Cosign bundles verified against the exact tag/workflow, independently on the qualification hosts where applicable. | Verify the final tag and compare executable bytes with `.19`. |
| Known limitations and exact compatibility matrix | **PASS** | This ledger, `COMPATIBILITY.md`, and the release notes name exact OMP `v17.3.8`/`858f7dd9`, Debian/macOS/Pixel versions, TUN-mode Serve requirement, unadvertised Windows, Android radio-transition limitation, Preview fallback, and unsupported relay/deployment modes. | Keep synchronized with every candidate and release. |
| Self-hosted/proxied relay | **N/A** | Explicitly unsupported and deferred. **Pin classification 2026-08-21: pin-independent.** `N/A` here is deliberate policy rather than an untested result. Self-hosted or proxied forwarding stays unsupported because `SECURITY.md` documents that any forwarder in front of the loopback listener defeats identity checking, so the OMP pin does not apply. It must not be advertised without a dedicated long-lived WebSocket soak and its own security qualification. | Do not advertise; a future release needs the dedicated WebSocket soak and a separate security qualification. |

> **Candidate artifacts `v0.1.0-prealpha.14`, `.15`, and `.16` have been deleted.** The build
> identifiers and tag names cited below therefore no longer resolve to a downloadable artifact.
> Nothing depends on their presence: `main` carries all of the code and evidence they were cut
> from, there were no consumers beyond machines that have since been destroyed, and a
> measurement does not stop being true because the artifact that produced it is gone. This is a
> traceability gap, not a correctness one. The next candidate will be cut when an artifact is
> actually needed.

## Alpha qualification blockers (historical)

The alpha decision was **NO-GO** until the following were closed. All six closed for the exact
alpha combinations recorded in the historical section above:

1. ~~at least one proposed host platform passes its complete native lifecycle and security matrix
   from the signed candidate artifact, including reboot/login persistence, upgrade, rollback,
   diagnostics, token rotation, and uninstall~~ — **closed 2026-08-20 for Debian 13 on x86-64**.
   Signed candidate `v0.1.0-prealpha.17`, independently verified from a clean directory
   (`shasum -c` OK, `gh attestation verify` exit 0, `cosign verify-blob` "Verified OK" for the
   archive, SBOM and `SHA256SUMS` against certificate identity
   `.../release.yml@refs/tags/v0.1.0-prealpha.17`), passed **49 assertions with 0 failures** across
   `artifact`, `lifecycle`, `migration`, `rollback`, `persistence` and `uninstall` on a fresh
   droplet, with `identity` passing separately earlier the same day. Per the rule below this list,
   that permits advertising **only** Debian 13 x86-64 with this exact candidate;
2. ~~real Tailscale Serve authorization and LAN/public isolation pass from distinct allowed and
   denied devices against that candidate host~~ — **closed 2026-08-20**. A tagged droplet
   (`tag:omp-session-gateway`) carries no user identity and was refused `403`
   through Serve on both `/api/v1/sessions` and `/`; this workstation, a distinct user-owned node,
   got `403` for a non-allowlisted real identity, `403` for a forged `Tailscale-User-Login` naming an
   allowlisted login, and `200` for the real allowlisted identity, with a forged header from an
   already-allowlisted caller simply ignored. Direct LAN and Tailscale-IP access already failed and
   Funnel is disabled. Measured against candidate `v0.1.0-prealpha.16`;
3. ~~a physical Android device passes install, automatic discovery, View, Control, interrupt,
   generation replacement, lock/resume, network-change, back-navigation, reconnect, and leak
   checks~~ — **closed 2026-08-21 by explicit founder decision to advertise without the two
   environment-blocked gates.** Everything the project is answerable for passed on the physical
   Pixel 10 Pro with Chrome `151.0.7922.139` against `v0.1.0-prealpha.17`: automatic discovery
   without Refresh, View and Control each `200` with a `no-store` capability, stale View **and**
   stale Control each `409 generation_mismatch`, unknown session `404`, generation replacement with
   revoke ordered before publish, lock/resume, PWA installability, the full attention appear-and-clear
   cycle, back navigation as a real history entry carrying no fragment, and a self-verifying
   capability-leak sweep clean across all seven forbidden sinks.
   **Network-change and reconnect are not proven and are advertised as a known limitation.** They are
   blocked by [#65](https://github.com/alphastorm/omp-session-gateway/issues/65), a Chrome-for-Android
   defect measured with the device healthy throughout — airplane off, Wi-Fi on, `ping 1.1.1.1` at 0%
   loss — while Chrome's own DevTools socket stopped answering with six Chrome processes alive, and
   `am force-stop` restored it instantly. It survived a Chrome 150 to 151 major-version bump. This is
   recorded as an environment defect with its evidence rather than dropped, and it was **not** closed
   by re-running until Chrome cooperated;
4. ~~the candidate OMP path passes branch, saved-session resume, and applicable default-relay
   connectivity scenarios without exposing a stale capability~~ — **closed 2026-08-20**. Switch
   ordering, socket-close crash removal, and TTL-sweeper expiry were measured at the `v17.3.8` pin on
   2026-08-19. Branch and resume were then measured against `v0.1.0-prealpha.17` on a session
   carrying **real conversation history** — two authored turns, the second explicitly referring back
   to the first, with real tool calls and a file written and then edited.
   **Branch:** generation 1 went absent at revision 21 and generation 2 appeared at revision 22, a
   977 ms window in which no card existed; the sequence was never `200`→`200`. Both stale
   `view` **and** stale `control` launches returned `409 generation_mismatch` while generation 2 was
   live, the live generation returned `200`, and generation `0` returned `400`. A second
   revoke/publish pair followed about 35 s later, independently reproducing the pair-of-pairs
   behaviour first recorded in `docs/LIFECYCLE_BRANCH_RESUME.md`.
   **Exit and resume:** `/exit` removed the record 6.6 s later, after which both generations of the
   exited instance returned `404 not_found`. `--continue` republished 13.8 s later as a **new
   instance** at generation 1, and the pre-exit instance stayed `404` for both generations
   throughout. Conversation history survived: the resumed session recalled the specific distinction
   discussed before the branch without re-reading the file. It also correctly reported the branched
   timeline's bullet count rather than the file's, which is worth knowing — a branch forks the
   conversation, not the filesystem;
5. ~~the native, Tailscale, relay, Android, browser, and signed-artifact rows are re-run at the
   current `v17.3.8` pin~~ — **closed 2026-08-21**. No ledger row is stale or indeterminate. **Audited 2026-08-20**: of the 23 ledger rows, **10 are current**
   (evidence at the refreshed pin or from a candidate built after it), **6 were stale**; **three
   have since been re-run at `v0.1.0-prealpha.17` on 2026-08-20/21** (Release signing/SBOM/provenance,
   Fifty-publisher capacity, and the host half of Three real OMP processes auto-discover), and on 2026-08-21 the remaining **three Android rows were re-run**
   at `v0.1.0-prealpha.17` on Chrome `151.0.7922.139`, so **no ledger row is stale**. The only
   evidence still outstanding anywhere is the network-change and reconnect pair inside the Android
   lock/resume row, which is blocked by the Chrome defect in
   [#65](https://github.com/alphastorm/omp-session-gateway/issues/65) rather than by a missing run
   and **7 were indeterminate** because their text cited no pin or date at all. **All seven were classified on
   2026-08-21 and each now states its position explicitly**: `Private vulnerability reporting` and the
   `Self-hosted/proxied relay` row are pin-independent, the latter being deliberate policy rather than an
   untested result; `Known limitations and exact compatibility matrix` is mixed, its boundary statements
   pin-independent while its *exact* baseline must be re-checked at every candidate; `Exact OMP and
   collab-web provenance` is repository state carrying `UPSTREAM.lock.json`'s own 2026-08-19 observation
   rather than a candidate revalidation; and `Loopback-only exposure`, `Real View and Control behavior`
   and `Platform install/doctor/uninstall` needed re-runs, of which the first and third are now
   superseded for Debian 13 and macOS 26.6.1 by the signed-candidate runs and the second is
   half-re-measured, its launch-authorization results current and its interaction half still open
   indeterminate** and are the priority: an indeterminate row cannot be treated as re-run, because doing
   so is exactly how a stale row gets silently promoted.
   **The relay component was originally accepted by explicit one-time exception, and the desirable
   full-window follow-up is now complete.** The earlier re-run reached 27,600 of 28,800 seconds,
   96% of the window, before an acceptance run fired real launches into the soak host's own relay
   room. That external contamination remains recorded as a failure rather than rewritten. A
   protected replacement ran the complete 28,800-second authored window on 2026-08-21, crossed 22
   relay-room transitions, finished `live`, and exited 0 with no process restart. The named record
   is `~/.local/share/omp-session-gateway/test/v0.1.0-alpha.1/soak/protected-relay-soak-8h.json`;
   the harness has no memory metric, so this run makes no RSS claim. This closes the outstanding
   current-alpha-pin full-window requirement; and
6. ~~every advertised host/client combination completes its candidate-artifact capability-leak
   acceptance across all forbidden sinks~~ — **closed 2026-08-20 for the one advertised
   combination**. Against `v0.1.0-prealpha.17` on a physical Pixel 10 Pro running Chrome
   `151.0.7922.139`, `scripts/android-leak-sweep.ts` planted a synthetic secret in all 7 forbidden
   sinks and detected all 7 before removing them, so the detector is proven live rather than
   vacuously clean. The real 66-character capability was then absent from every sink, from resource
   timings, and from the DOM; the launch response was `200` with `no-store, max-age=0`; the address
   bar retained a 0-character fragment. This covers the Linux host and this Android client only.

Blocker 7, the silent publisher latch
([#61](https://github.com/alphastorm/omp-session-gateway/issues/61)), is **closed**. The fix is
mirrored here as the sixth handoff commit (`bfc555227`) and was clean-room verified on 2026-08-20:
all six commits `git am` onto pristine `858f7dd9` from a fresh shallow clone,
`registry-publisher.test.ts` passes 13/13 and `controller.test.ts` 15/15. The behavioral gap was
then closed with a live tracer against an isolated gateway on the activated release, recording the
full state-faithful transition `publishing` → `retrying (attempt 8: EACCES)` → `publishing` with no
manual `/collab` or process restart. The fault denied read access to a launcher-scoped
`OMP_GATEWAY_PUBLISHER_TOKEN_PATH` copy and restarted the isolated gateway to force a token reread;
the card vanished and returned about 20 seconds after access was restored. Production was
untouched: the daemon stayed alive on the candidate and the tailnet origin kept answering `200`.
Process, instance, and publisher-token fingerprints are intentionally omitted from this public
ledger.

Passing one platform permits advertising only that exact qualified platform/version combination.
It does not promote untested rows or broaden the pinned OMP range. Two platforms passed, so two
are advertised; every other host, browser, device and OMP version remains unqualified.

## Known limitations

- The gateway requires the exact pinned OMP source plus the repository patch; there is no
  upstream release/API compatibility promise yet.
- A daemon restart intentionally starts with an empty in-memory registry until live publishers
  reconnect.
- Browser reload intentionally returns to the session directory because collaboration
  capabilities are not persisted.
- The existing OMP relay remains an availability and traffic-metadata dependency.
- Same-desktop-user malware, a compromised browser/OS, and an unlocked authorized phone are
  outside or inherited trust boundaries described in `SECURITY.md`.
- Tagged Tailscale source devices, Tailscale Funnel, Portal Tunnel, public/LAN HTTP, self-hosted
  relays, WebAuthn gating, TWA/native clients, and multi-host federation are not supported by this
  release line. Background Web Push is implemented but remains unqualified until the physical
  Android closed-PWA, lock-screen, tap-to-Control, stale-generation, force-stop, and network matrix
  passes.
- Gateway rollback-by-reinstall from candidate `.20` to alpha.1 passed on Debian and macOS. OMP
  rollback remains a separate manual operation: stop patched OMP processes, repoint the versioned
  symlink to the exact alpha v17.3.8 build, and repeat source/tree/version/config assertions before
  restarting. Isolated alpha→beta→alpha symlink/config reversal passed; paired gateway/OMP
  update/rollback is not implemented or claimed.

## Updating this ledger

Change a row only with a reproducible command result or a named manual qualification record that
identifies the source commit, artifact checksum, OS/browser/device versions, deployment path, and
date. Record failures as failures; do not turn a narrower automated pass into a broader platform
claim. Update this file, `COMPATIBILITY.md`, `CHANGELOG.md`, and release notes together whenever a
support claim or gate changes.
