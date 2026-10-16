# Local builds and releases

Stark Code is currently built and updated locally. This checkout has no publishing
workflow, configured release feed, public installer endpoint, or hosted web service.
The install scripts intentionally exit with a local-build message. Do not use an npm
package, app-store listing, or download URL as the distribution source for this fork
unless a maintainer has explicitly configured and verified it.

## Start the app

Use Node.js 24 and follow [Start the Mac app](../../README.md#start-the-mac-app).
`Start Stark Code.command` keeps development state inside the checkout's `.stark-code`
directory, separate from the installed app's data.

## Package a local desktop build

From the repository root, after installing the pinned dependencies:

```sh
npm run dist:desktop:dmg:arm64
```

For an Intel Mac, use `npm run dist:desktop:dmg:x64`. Other packaging targets are listed
in the root `package.json`. Builds are written to `release/`. The packaging script can
use platform signing credentials when supplied; building an artifact does not publish it.
An unsigned build may require local operating-system approval before opening.

Before distributing a build, test the packaged app with a separate data directory,
verify its version and bundled provider/plugin behavior, and confirm that it contains no
unconfigured service or download links. Provide the verified artifact directly through
the team's chosen distribution channel.

## Adding a release service later

A maintainer must choose and configure the actual repository, download location,
platform signing credentials, update feed and contact details before enabling automated
releases. Hosted clients and relay/sign-in services are separate deployments and remain
disabled in the current app. No fallback public domain is assumed.
