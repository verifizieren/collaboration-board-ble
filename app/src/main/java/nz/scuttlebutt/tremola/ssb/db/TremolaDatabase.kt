package nz.scuttlebutt.tremola.ssb.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import nz.scuttlebutt.tremola.ssb.db.daos.*
import nz.scuttlebutt.tremola.ssb.db.entities.*
import nz.scuttlebutt.tremola.utils.SingletonHolder

private val MIGRATION_15_16 = object : Migration(15, 16) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL(
            "CREATE TABLE IF NOT EXISTS `BoardOperation` (" +
                "`operation_id` TEXT NOT NULL, `room_id` TEXT NOT NULL, " +
                "`author_id` TEXT NOT NULL, `author_seq` INTEGER NOT NULL, " +
                "`event_time` INTEGER NOT NULL, `wire_json` TEXT NOT NULL, " +
                "`received_at` INTEGER NOT NULL, " +
                "PRIMARY KEY(`room_id`, `operation_id`))"
        )
        database.execSQL(
            "CREATE UNIQUE INDEX IF NOT EXISTS " +
                "`index_BoardOperation_room_id_author_id_author_seq` " +
                "ON `BoardOperation` (`room_id`, `author_id`, `author_seq`)"
        )
        database.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_BoardOperation_room_id_event_time` " +
                "ON `BoardOperation` (`room_id`, `event_time`)"
        )
    }
}

private val MIGRATION_16_17 = object : Migration(16, 17) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL(
            "CREATE TABLE IF NOT EXISTS `BoardOperation_new` (" +
                "`operation_id` TEXT NOT NULL, `room_id` TEXT NOT NULL, " +
                "`author_id` TEXT NOT NULL, `author_seq` INTEGER NOT NULL, " +
                "`event_time` INTEGER NOT NULL, `wire_json` TEXT NOT NULL, " +
                "`received_at` INTEGER NOT NULL, " +
                "PRIMARY KEY(`room_id`, `operation_id`))"
        )
        database.execSQL(
            "INSERT OR IGNORE INTO `BoardOperation_new` (" +
                "`operation_id`, `room_id`, `author_id`, `author_seq`, " +
                "`event_time`, `wire_json`, `received_at`) " +
                "SELECT `operation_id`, `room_id`, `author_id`, `author_seq`, " +
                "`event_time`, `wire_json`, `received_at` FROM `BoardOperation`"
        )
        database.execSQL("DROP TABLE `BoardOperation`")
        database.execSQL("ALTER TABLE `BoardOperation_new` RENAME TO `BoardOperation`")
        database.execSQL(
            "CREATE UNIQUE INDEX IF NOT EXISTS " +
                "`index_BoardOperation_room_id_author_id_author_seq` " +
                "ON `BoardOperation` (`room_id`, `author_id`, `author_seq`)"
        )
        database.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_BoardOperation_room_id_event_time` " +
                "ON `BoardOperation` (`room_id`, `event_time`)"
        )
    }
}

@Database(
    entities = [Contact::class, LogEntry::class, Pub::class,
                Blob::class, Follow::class, BoardOperation::class],
    version = 17,
    exportSchema = false
)

abstract class TremolaDatabase : RoomDatabase(){
    abstract fun contactDAO(): ContactDAO
    abstract fun logDAO() :    LogEntryDAO
    abstract fun pubDAO() :    PubDAO
    abstract fun boardOperationDAO(): BoardOperationDAO
    // not used for now:
    abstract fun blobDAO():    Notused_BlobDAO
    abstract fun followDAO() : Notused_FollowDAO

    companion object: SingletonHolder<TremolaDatabase, Context>({
        Room.databaseBuilder(it, TremolaDatabase::class.java, "surfcity_db")
            .addCallback(object: RoomDatabase.Callback(){})
            .addMigrations(MIGRATION_15_16, MIGRATION_16_17)
            .fallbackToDestructiveMigration()
            .build()
    })
}
