// Training page: what the next ride will do. A workout file and the guided FTP test. A workout
// can be loaded or removed during a ride; the FTP test waits for the ride to finish.
// Climb feel (trainer difficulty) is in the Trainer control band on Live, to change mid-ride.
import { FtpTestSettings, type FtpTestSettingsProps } from '../ftp/ftp';
import { PageHead } from '../nav/nav';
import { WorkoutSettings, type WorkoutSettingsProps } from '../workout/workout';

interface TrainProps { workout: WorkoutSettingsProps; ftpTest?: FtpTestSettingsProps }

export function Train({ workout, ftpTest }: TrainProps) {
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
    </section>
  );
}
