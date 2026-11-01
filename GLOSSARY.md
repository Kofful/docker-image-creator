# Docker Image Creator

Docker Image Creator produces container environments and checks whether they can run.

## Language

**Configuration**:
A saved definition of a container environment containing one or more services.
_Avoid_: App, stack, when referring to the saved definition

**Deleted configuration**:
A retired configuration retained as history and unavailable for use.
_Avoid_: Stopped configuration, which suggests its services can be started again

**Service**:
One component of a configuration, such as a Python application or a MySQL database.
_Avoid_: App, when referring to a single component

**Deployment**:
An instance of a configuration maintained for use beyond a temporary validation run.
_Avoid_: Validation run

**Generated bundle**:
The generated definition of a requested container environment, including the settings and starter behavior needed by its services.
_Avoid_: Config, when referring to the whole bundle

**Generation attempt**:
One effort to produce a generated bundle and assess whether it can run, including an unsuccessful effort.
_Avoid_: Configuration, when referring to the attempt and its outcome

**Validation run**:
A temporary trial of a generated bundle that attempts to start its services and stops them after a successful check.
_Avoid_: Deployment, when referring only to this temporary trial
