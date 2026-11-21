// Training page: what the next ride will do. A workout file, the guided FTP test, and how hard
// climbs feel when Trainer control is on. Each part works during a ride too (a workout can be
// loaded or removed, Climb feel changes at once); the FTP test waits for the ride to finish.
import { ClimbFeel } from '../control/climb-feel';
import { FtpTestSettings, type FtpTestSettingsProps } from '../ftp/ftp';
import { PageHead } from '../nav/nav';
import { WorkoutSettings, type WorkoutSettingsProps } from '../workout/workout';
import type { SimSettings } from '../types/feed';

interface TrainProps { workout: WorkoutSettingsProps; ftpTest?: FtpTestSettingsProps; sim?: SimSettings }

export function Train({ workout, ftpTest, sim }: TrainProps) {
  return (
    <section className="page" aria-labelledby="train-h">
      <PageHead id="train-h" title="Training">Set up the ride before you press Start. The workout band and Trainer control show on Live.</PageHead>
      <section className="settings" aria-labelledby="train-wo">
        <h3 id="train-wo">Workout</h3>
        <div className="field wide"><WorkoutSettings {...workout} /></div>
      </section>
      {ftpTest && <section className="settings" aria-labelledby="train-ftp">
        <h3 id="train-ftp">FTP test</h3>
        <div className="field wide"><FtpTestSettings {...ftpTest} /></div>
      </section>}
      {sim && <section className="settings" aria-labelledby="train-feel">
        <h3 id="train-feel">Climb feel</h3>
        <ClimbFeel sim={sim} />
      </section>}
    </section>
  );
}
