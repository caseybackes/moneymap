#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle { NeverInitialized, Initialized, Active, Retired, Missing, Corrupt }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseEvidence { Missing, Unreadable, Readable }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistryEvidence { Missing, Corrupt, Valid }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    FirstRun,
    Healthy,
    RepairRegistry,
    OrphanedRemoteAuthority,
    LostLocalState,
    UnknownAuthority,
    Retired,
}

impl Decision {
    pub fn blocks_new_connection(self) -> bool {
        matches!(self, Self::OrphanedRemoteAuthority | Self::LostLocalState | Self::UnknownAuthority)
    }
}

pub fn evaluate(
    lifecycle: Lifecycle,
    database: DatabaseEvidence,
    registry: RegistryEvidence,
    database_handles: usize,
    registry_handles: usize,
    database_ahead: bool,
    registry_ahead: bool,
) -> Decision {
    if matches!(lifecycle, Lifecycle::Corrupt) || matches!(registry, RegistryEvidence::Corrupt) {
        return Decision::UnknownAuthority;
    }
    if lifecycle == Lifecycle::Retired && database != DatabaseEvidence::Readable {
        return Decision::Retired;
    }
    if database != DatabaseEvidence::Readable {
        if registry == RegistryEvidence::Valid && registry_handles > 0 {
            return Decision::LostLocalState;
        }
        return match lifecycle {
            Lifecycle::NeverInitialized | Lifecycle::Missing => Decision::FirstRun,
            Lifecycle::Retired => Decision::Retired,
            Lifecycle::Initialized if registry != RegistryEvidence::Corrupt => Decision::FirstRun,
            Lifecycle::Active | Lifecycle::Corrupt | Lifecycle::Initialized => Decision::UnknownAuthority,
        };
    }
    if registry_ahead { return Decision::OrphanedRemoteAuthority; }
    if database_ahead || (database_handles > 0 && registry == RegistryEvidence::Missing) {
        return Decision::RepairRegistry;
    }
    if lifecycle == Lifecycle::Active && database_handles == 0 && registry_handles == 0 {
        return Decision::UnknownAuthority;
    }
    Decision::Healthy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_state_matrix_fails_closed() {
        assert_eq!(evaluate(Lifecycle::Missing, DatabaseEvidence::Missing, RegistryEvidence::Missing, 0, 0, false, false), Decision::FirstRun);
        assert_eq!(evaluate(Lifecycle::Initialized, DatabaseEvidence::Readable, RegistryEvidence::Valid, 0, 0, false, false), Decision::Healthy);
        assert_eq!(evaluate(Lifecycle::Active, DatabaseEvidence::Readable, RegistryEvidence::Valid, 1, 1, false, false), Decision::Healthy);
        assert_eq!(evaluate(Lifecycle::Active, DatabaseEvidence::Readable, RegistryEvidence::Missing, 1, 0, true, false), Decision::RepairRegistry);
        assert_eq!(evaluate(Lifecycle::Active, DatabaseEvidence::Readable, RegistryEvidence::Valid, 1, 2, false, true), Decision::OrphanedRemoteAuthority);
        assert_eq!(evaluate(Lifecycle::Active, DatabaseEvidence::Missing, RegistryEvidence::Valid, 0, 1, false, true), Decision::LostLocalState);
        assert_eq!(evaluate(Lifecycle::Active, DatabaseEvidence::Unreadable, RegistryEvidence::Missing, 0, 0, false, false), Decision::UnknownAuthority);
        assert_eq!(evaluate(Lifecycle::Active, DatabaseEvidence::Readable, RegistryEvidence::Corrupt, 1, 0, false, false), Decision::UnknownAuthority);
        assert_eq!(evaluate(Lifecycle::Retired, DatabaseEvidence::Missing, RegistryEvidence::Valid, 0, 0, false, false), Decision::Retired);
        assert!(Decision::UnknownAuthority.blocks_new_connection());
        assert!(!Decision::Healthy.blocks_new_connection());
    }
}
